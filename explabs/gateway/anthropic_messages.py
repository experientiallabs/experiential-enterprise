# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Inbound Anthropic Messages protocol adapter for the gateway worker.

Translates ``POST /v1/messages`` (the Anthropic Messages API that Claude Code
and the Anthropic SDKs speak) onto the worker's existing OpenAI Chat
Completions surface, and translates the response — JSON or SSE — back into
Anthropic wire shapes. The adapter is a pure protocol seam: auth, catalog
resolution, waterfall routing, budgets, idempotency, and usage accounting all
happen in the one Experiential dispatch path this adapter self-calls, so ``/v1/messages``
can never drift from ``/v1/chat/completions`` semantics.

Translation policy (the contract, documented at /docs/coding-agents):

- Text, tool use, and tool results translate faithfully in both directions.
- ``thinking`` requests and ``thinking``/``redacted_thinking`` history blocks
  are DROPPED: the OpenAI surface has no extended-thinking channel, and
  Anthropic clients (Claude Code included) send them routinely, so rejecting
  would make the lane unusable. Models simply run without extended thinking.
- ``cache_control`` annotations are dropped: prompt caching is a provider
  concern the gateway does not surface.
- ``image`` and ``document`` blocks are REJECTED loudly: the gateway's chat
  surface is text-only, and silently discarding content the caller sent would
  corrupt the conversation.
- Sampling fields the gateway does not support (``top_p``, ``top_k``) are
  rejected loudly rather than silently ignored.
- ``stop_sequence`` in responses is always ``null``: the gateway never reports
  which stop sequence matched, so a stop-sequence hit surfaces as ``end_turn``.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterable, AsyncIterator
from typing import TYPE_CHECKING, Any, Literal, cast

# _exception_response is Experiential-private, imported on purpose: it is the single
# authority mapping gateway failures to statuses/codes, and this adapter must
# answer exactly what the chat surface would (see _translate_exception).
from exp.runtime.gateway.service import GatewayService, _exception_response
from exp.runtime.openai_protocol.requests import decode_chat
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from explabs.gateway.db import GatewayDatabase
from explabs.gateway.verification_notice import (
    apply_verify_email_notice,
    is_insufficient_quota_envelope,
    org_owner_unverified_for_key,
)

if TYPE_CHECKING:
    from exp.common.core.artifacts import JsonObject

# Anthropic error envelope -----------------------------------------------------

AnthropicErrorType = Literal[
    "invalid_request_error",
    "authentication_error",
    "permission_error",
    "not_found_error",
    "request_too_large",
    "rate_limit_error",
    "api_error",
    "overloaded_error",
]


class AnthropicProtocolError(Exception):
    """An error that must reach the caller in Anthropic envelope shape."""

    def __init__(self, status_code: int, error_type: AnthropicErrorType, message: str) -> None:
        """Capture the HTTP status and Anthropic error type to serialize."""
        super().__init__(message)
        self.status_code = status_code
        self.error_type: AnthropicErrorType = error_type
        self.message = message

    def json_body(self) -> dict[str, Any]:
        """Return the Anthropic wire envelope for this error."""
        return {"type": "error", "error": {"type": self.error_type, "message": self.message}}


def _invalid_request(message: str) -> AnthropicProtocolError:
    return AnthropicProtocolError(400, "invalid_request_error", message)


def translate_openai_error(status_code: int, body: dict[str, Any]) -> AnthropicProtocolError:
    """Map the gateway's OpenAI error envelope onto Anthropic's.

    Branches on HTTP status first (``unavailable_route`` appears at both 429
    and 503 with the same code), then on the envelope's ``type``. The OpenAI
    ``param`` pointer has no Anthropic field, so it is folded into the message.
    """
    raw_detail = body.get("error")
    detail: dict[str, Any] = raw_detail if isinstance(raw_detail, dict) else {}
    message = str(detail.get("message") or "The gateway returned an error.")
    param = detail.get("param")
    if isinstance(param, str) and param:
        message = f"{message} (param: {param})"
    openai_type = detail.get("type")
    error_type: AnthropicErrorType
    match status_code:
        case 401:
            error_type = "authentication_error"
        case 403:
            error_type = "permission_error"
        case 404:
            error_type = "not_found_error"
        case 429:
            error_type = "rate_limit_error"
        case 503:
            error_type = "overloaded_error"
        case _ if openai_type == "invalid_request_error":
            error_type = "invalid_request_error"
        case _:
            error_type = "api_error"
    return AnthropicProtocolError(status_code, error_type, message)


# Inbound request models (the typed boundary) ----------------------------------
#
# extra="forbid" mirrors the gateway's own closed manifest: an unknown field is
# a loud 400 naming the field, never a silent drop. Fields the adapter accepts
# but deliberately discards (thinking, cache_control, metadata beyond user_id)
# are modeled explicitly so the policy is visible in the schema.


class _AdapterModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _CacheControl(_AdapterModel):
    """Anthropic prompt-caching annotation. Accepted and dropped in translation."""

    type: Literal["ephemeral"]
    ttl: Literal["5m", "1h"] | None = None


class _TextBlock(_AdapterModel):
    type: Literal["text"]
    text: str
    cache_control: _CacheControl | None = None


class _ThinkingBlock(_AdapterModel):
    type: Literal["thinking"]
    thinking: str = ""
    signature: str | None = None  # accepted, dropped


class _RedactedThinkingBlock(_AdapterModel):
    type: Literal["redacted_thinking"]
    data: str = ""


class _ToolUseBlock(_AdapterModel):
    type: Literal["tool_use"]
    id: str
    name: str
    input: dict[str, Any]
    cache_control: _CacheControl | None = None


class _ToolResultBlock(_AdapterModel):
    type: Literal["tool_result"]
    tool_use_id: str
    content: str | list[_TextBlock] | None = None
    is_error: bool = False  # accepted, dropped: the model reads the error text
    cache_control: _CacheControl | None = None


_ContentBlock = (
    _TextBlock | _ThinkingBlock | _RedactedThinkingBlock | _ToolUseBlock | _ToolResultBlock
)


class _AnthropicMessage(_AdapterModel):
    role: Literal["user", "assistant"]
    content: str | list[_ContentBlock]
    cache_control: _CacheControl | None = None


class _AnthropicTool(_AdapterModel):
    name: str
    description: str | None = None
    input_schema: dict[str, Any]
    cache_control: _CacheControl | None = None
    type: Literal["custom"] | None = None


class _ToolChoice(_AdapterModel):
    type: Literal["auto", "any", "tool", "none"]
    name: str | None = None
    disable_parallel_tool_use: bool | None = None


class _Metadata(_AdapterModel):
    user_id: str | None = None


class _ThinkingConfig(_AdapterModel):
    type: Literal["enabled", "disabled"]
    budget_tokens: int | None = None


class AnthropicMessagesRequest(_AdapterModel):
    """The accepted subset of the Anthropic Messages request body."""

    model: str = Field(min_length=1, max_length=256)
    messages: list[_AnthropicMessage] = Field(min_length=1)
    max_tokens: int = Field(gt=0)
    system: str | list[_TextBlock] | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    stop_sequences: list[str] | None = None
    stream: bool = False
    tools: list[_AnthropicTool] | None = None
    tool_choice: _ToolChoice | None = None
    metadata: _Metadata | None = None
    thinking: _ThinkingConfig | None = None  # accepted, dropped


_REJECTED_BLOCK_HINTS = {
    "image": "image blocks are not supported: the gateway's chat surface is text-only",
    "document": "document blocks are not supported: the gateway's chat surface is text-only",
    "server_tool_use": "server tools are not supported by the gateway",
    "web_search_tool_result": "server tools are not supported by the gateway",
}


def decode_messages_request(raw: bytes) -> AnthropicMessagesRequest:
    """Validate the raw body into the typed request or raise the 400 to send.

    Error messages name the offending field path so an Anthropic client gets
    the same actionable pointer the OpenAI envelope's ``param`` would carry.
    """
    try:
        payload = json.loads(raw)
    except ValueError as error:
        raise _invalid_request(f"Request body is not valid JSON: {error}") from error
    if not isinstance(payload, dict):
        msg = "Request body must be a JSON object."
        raise _invalid_request(msg)
    try:
        return AnthropicMessagesRequest.model_validate(payload)
    except ValidationError as error:
        first = error.errors()[0]
        path = ".".join(str(part) for part in first["loc"])
        # A block type we know about but refuse gets its own explanation
        # instead of pydantic's union-mismatch wall.
        hint = _rejected_block_hint(payload)
        if hint is not None:
            raise _invalid_request(hint) from error
        raise _invalid_request(f"Invalid value for '{path}': {first['msg']}") from error


def _rejected_block_hint(payload: dict[str, Any]) -> str | None:
    """Return a targeted message when a known-but-unsupported block is present."""
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return None
    for message in messages:
        if not isinstance(message, dict) or not isinstance(message.get("content"), list):
            continue
        for block in message["content"]:
            if not isinstance(block, dict):
                continue
            hint = _REJECTED_BLOCK_HINTS.get(str(block.get("type")))
            if hint is not None:
                return hint
            if block.get("type") == "tool_result" and isinstance(block.get("content"), list):
                for inner in block["content"]:
                    if isinstance(inner, dict) and inner.get("type") in _REJECTED_BLOCK_HINTS:
                        return _REJECTED_BLOCK_HINTS[str(inner["type"])]
    return None


# Request translation: Anthropic -> Chat Completions ----------------------------


def to_chat_completions_body(request: AnthropicMessagesRequest) -> dict[str, Any]:
    """Build the Chat Completions body the adapter self-dispatches."""
    messages: list[dict[str, Any]] = []
    system_text = _system_text(request.system)
    if system_text:  # an empty system prompt is dropped, not forwarded as ""
        messages.append({"role": "system", "content": system_text})
    for message in request.messages:
        messages.extend(_translate_message(message))

    body: dict[str, Any] = {
        "model": request.model,
        "messages": messages,
        "max_tokens": request.max_tokens,
    }
    if request.temperature is not None:
        body["temperature"] = request.temperature
    if request.stop_sequences:
        body["stop"] = _stop_list(request.stop_sequences)
    if request.stream:
        body["stream"] = True
        # Without include_usage the gateway emits no usage chunk at all, and
        # Anthropic clients expect usage in message_delta.
        body["stream_options"] = {"include_usage": True}
    if request.tools:
        body["tools"] = _translate_tools(request.tools)
    if request.tool_choice is not None:
        body["tool_choice"] = _translate_tool_choice(request.tool_choice)
        if request.tool_choice.disable_parallel_tool_use:
            body["parallel_tool_calls"] = False
    if request.metadata is not None and request.metadata.user_id is not None:
        body["metadata"] = {"user_id": request.metadata.user_id}
    return body


def _system_text(system: str | list[_TextBlock] | None) -> str | None:
    match system:
        case None:
            return None
        case str():
            return system
        case list():
            # Mirrors Experiential's outbound flattening: parts joined with a blank line.
            return "\n\n".join(block.text for block in system)


def _stop_list(sequences: list[str]) -> list[str]:
    """Dedupe stop sequences (the gateway rejects duplicates and empties)."""
    deduped = list(dict.fromkeys(sequences))
    if any(not sequence for sequence in deduped):
        msg = "stop_sequences entries must be non-empty strings."
        raise _invalid_request(msg)
    return deduped


def _translate_tools(tools: list[_AnthropicTool]) -> list[dict[str, Any]]:
    """Translate Anthropic tool definitions into OpenAI function tools."""
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description or "",
                "parameters": tool.input_schema,
            },
        }
        for tool in tools
    ]


def _translate_message(message: _AnthropicMessage) -> list[dict[str, Any]]:  # noqa: C901 - one content-block dispatch; each case is a protocol rule
    """Translate one Anthropic message into one or more OpenAI messages.

    ``tool_result`` blocks must become standalone ``role: "tool"`` messages
    (the gateway rejects ``tool_call_id`` on other roles), so a user turn that
    mixes tool results and text splits into several messages, in order.
    """
    if isinstance(message.content, str):
        if not message.content:
            raise _invalid_request(f"{message.role} message content must not be empty.")
        return [{"role": message.role, "content": message.content}]

    out: list[dict[str, Any]] = []
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []

    def flush() -> None:
        content = "".join(text_parts) if text_parts else None
        if content is None and not tool_calls:
            return
        entry: dict[str, Any] = {"role": message.role}
        if content is not None:
            entry["content"] = content
        if tool_calls:
            entry["tool_calls"] = list(tool_calls)
        out.append(entry)
        text_parts.clear()
        tool_calls.clear()

    for block in message.content:
        match block:
            case _TextBlock():
                text_parts.append(block.text)
            case _ThinkingBlock() | _RedactedThinkingBlock():
                continue  # dropped by policy: no thinking channel on this surface
            case _ToolUseBlock():
                if message.role != "assistant":
                    msg = "tool_use blocks are only valid in assistant messages."
                    raise _invalid_request(msg)
                tool_calls.append(
                    {
                        "id": block.id,
                        "type": "function",
                        "function": {
                            "name": block.name,
                            "arguments": json.dumps(block.input, ensure_ascii=False),
                        },
                    }
                )
            case _ToolResultBlock():
                if message.role != "user":
                    msg = "tool_result blocks are only valid in user messages."
                    raise _invalid_request(msg)
                flush()
                out.append(
                    {
                        "role": "tool",
                        "tool_call_id": block.tool_use_id,
                        "content": _tool_result_text(block),
                    }
                )
    flush()
    if not out:
        raise _invalid_request(
            f"{message.role} message must contain text, tool_use, or tool_result content."
        )
    return out


def _tool_result_text(block: _ToolResultBlock) -> str:
    match block.content:
        case None:
            return ""
        case str():
            return block.content
        case list():
            return "".join(part.text for part in block.content)


def _translate_tool_choice(choice: _ToolChoice) -> str | dict[str, Any]:
    match choice.type:
        case "auto":
            return "auto"
        case "none":
            return "none"
        case "any":
            return "required"
        case "tool":
            if not choice.name:
                msg = "tool_choice of type 'tool' requires a name."
                raise _invalid_request(msg)
            return {"type": "function", "function": {"name": choice.name}}


# Response translation: Chat Completions -> Anthropic ---------------------------

_STOP_REASONS = {"stop": "end_turn", "length": "max_tokens", "tool_calls": "tool_use"}


def _mint_message_id() -> str:
    return f"msg_{uuid.uuid4().hex}"


def _usage_from_chat(usage: dict[str, Any] | None) -> dict[str, Any]:
    """Recover Anthropic usage counters from the Chat Completions usage object.

    The gateway folds Anthropic's three input counters into ``prompt_tokens``;
    cached reads come back out of ``prompt_tokens_details.cached_tokens``, but
    cache-creation tokens are unrecoverable and stay folded into input_tokens.
    """
    if not usage:
        return {"input_tokens": 0, "output_tokens": 0}
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    details = usage.get("prompt_tokens_details")
    cached = int(details.get("cached_tokens") or 0) if isinstance(details, dict) else 0
    out: dict[str, Any] = {"input_tokens": prompt - cached, "output_tokens": completion}
    if cached:
        out["cache_read_input_tokens"] = cached
    return out


def translate_chat_completion(body: dict[str, Any]) -> dict[str, Any]:
    """Translate a non-streaming Chat Completions body into an Anthropic Message."""
    choices = body.get("choices") or []
    if not choices:
        raise AnthropicProtocolError(502, "api_error", "The gateway returned no completion choice.")
    choice = choices[0]
    message = choice.get("message") or {}
    if message.get("refusal"):
        # The upstream decoder turns provider refusals into failures; a refusal
        # here has no Anthropic content shape, so surface it as an error.
        raise AnthropicProtocolError(502, "api_error", str(message["refusal"]))

    content: list[dict[str, Any]] = []
    if message.get("content"):
        content.append({"type": "text", "text": message["content"]})
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        try:
            tool_input = json.loads(function.get("arguments") or "{}")
        except ValueError:
            tool_input = {}
        content.append(
            {
                "type": "tool_use",
                "id": call.get("id") or _mint_message_id(),
                "name": function.get("name") or "",
                "input": tool_input if isinstance(tool_input, dict) else {},
            }
        )

    finish_reason = choice.get("finish_reason")
    return {
        "id": _mint_message_id(),
        "type": "message",
        "role": "assistant",
        "model": body.get("model") or "",
        "content": content,
        "stop_reason": _STOP_REASONS.get(finish_reason, "end_turn"),
        "stop_sequence": None,
        "usage": _usage_from_chat(body.get("usage")),
    }


# Streaming translation: Chat SSE -> Anthropic SSE -------------------------------


def _event(name: str, payload: dict[str, Any]) -> bytes:
    return f"event: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


class _StreamState:
    """Tracks the one open content block while translating one stream.

    The gateway's chat encoder is strictly sequential — text, then tool calls
    in index order, each tool introduced by an id-bearing frame — so exactly
    one Anthropic block is open at a time.
    """

    def __init__(self, model: str) -> None:
        self.model = model
        self.message_id = _mint_message_id()
        self.next_block_index = 0
        self.open_block: int | None = None
        self.open_kind: Literal["text", "tool"] | None = None
        self.open_tool_for: int | None = None
        self.finish_reason: str | None = None
        self.usage: dict[str, Any] | None = None

    def message_start(self) -> bytes:
        # The gateway only reports usage in its final chunk, so input_tokens
        # starts at 0 here and the true counts land in message_delta — the
        # cumulative-correction pattern Anthropic's usage semantics allow.
        return _event(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": self.message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.model,
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 0, "output_tokens": 0},
                },
            },
        )

    def open_text_block(self) -> list[bytes]:
        events = self.close_block()
        index = self.next_block_index
        self.next_block_index += 1
        self.open_block = index
        self.open_kind = "text"
        self.open_tool_for = None
        events.append(
            _event(
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": index,
                    "content_block": {"type": "text", "text": ""},
                },
            )
        )
        return events

    def open_tool_block(self, openai_index: int, call: dict[str, Any]) -> list[bytes]:
        events = self.close_block()
        index = self.next_block_index
        self.next_block_index += 1
        self.open_block = index
        self.open_kind = "tool"
        self.open_tool_for = openai_index
        function = call.get("function") or {}
        events.append(
            _event(
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": index,
                    "content_block": {
                        "type": "tool_use",
                        "id": call.get("id") or _mint_message_id(),
                        "name": function.get("name") or "",
                        "input": {},
                    },
                },
            )
        )
        return events

    def close_block(self) -> list[bytes]:
        if self.open_block is None:
            return []
        event = _event(
            "content_block_stop", {"type": "content_block_stop", "index": self.open_block}
        )
        self.open_block = None
        self.open_kind = None
        self.open_tool_for = None
        return [event]

    def finale(self) -> list[bytes]:
        events = self.close_block()
        usage = _usage_from_chat(self.usage)
        events.append(
            _event(
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {
                        "stop_reason": _STOP_REASONS.get(self.finish_reason or "", "end_turn"),
                        "stop_sequence": None,
                    },
                    "usage": usage,
                },
            )
        )
        events.append(_event("message_stop", {"type": "message_stop"}))
        return events


def _iter_sse_data(chunks: AsyncIterable[bytes | str | memoryview[int]]) -> AsyncIterator[str]:
    """Split a raw SSE byte stream into the ``data:`` payload of each frame."""

    async def generator() -> AsyncIterator[str]:
        buffer = b""
        async for chunk in chunks:
            buffer += chunk.encode("utf-8") if isinstance(chunk, str) else bytes(chunk)
            while b"\n\n" in buffer:
                frame, buffer = buffer.split(b"\n\n", 1)
                for line in frame.split(b"\n"):
                    if line.startswith(b"data:"):
                        yield line[len(b"data:") :].strip().decode("utf-8")

    return generator()


async def translate_chat_sse(  # noqa: C901, PLR0912 - one SSE state machine; splitting it would scatter the block invariants
    model: str, chunks: AsyncIterable[bytes | str | memoryview[int]]
) -> AsyncIterator[bytes]:
    """Translate the gateway's Chat Completions SSE into Anthropic SSE events.

    Mid-stream failures arrive as a data frame carrying the OpenAI error
    envelope (the HTTP 200 is already committed); those become a terminal
    Anthropic ``error`` event.
    """
    state = _StreamState(model)
    started = False
    saw_done = False
    async for data in _iter_sse_data(chunks):
        if data == "[DONE]":
            saw_done = True
            break
        try:
            frame = json.loads(data)
        except ValueError:
            continue
        if not isinstance(frame, dict):
            continue
        if "error" in frame:
            if not started:
                yield state.message_start()
                started = True
            translated = translate_openai_error(500, frame)
            yield _event("error", translated.json_body())
            return
        if not started:
            yield state.message_start()
            yield _event("ping", {"type": "ping"})
            started = True
        if frame.get("usage"):
            state.usage = frame["usage"]
        choices = frame.get("choices") or []
        if not choices:
            continue
        choice = choices[0]
        delta = choice.get("delta") or {}
        if choice.get("finish_reason"):
            state.finish_reason = choice["finish_reason"]
        if delta.get("content"):
            if state.open_kind != "text":
                for event in state.open_text_block():
                    yield event
            yield _event(
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": state.open_block,
                    "delta": {"type": "text_delta", "text": delta["content"]},
                },
            )
        for call in delta.get("tool_calls") or []:
            openai_index = int(call.get("index") or 0)
            if state.open_kind != "tool" or state.open_tool_for != openai_index:
                for event in state.open_tool_block(openai_index, call):
                    yield event
            arguments = (call.get("function") or {}).get("arguments")
            if arguments:
                yield _event(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": state.open_block,
                        "delta": {"type": "input_json_delta", "partial_json": arguments},
                    },
                )
    if not started:
        yield state.message_start()
    if not saw_done:
        # The upstream ended without its terminal frame: the response is
        # truncated, and a clean finale would mask it as complete.
        truncated = AnthropicProtocolError(
            502, "api_error", "The gateway stream ended before completing."
        )
        yield _event("error", truncated.json_body())
        return
    for event in state.finale():
        yield event


# Route ---------------------------------------------------------------------------


def register_messages_route(app: FastAPI, service: GatewayService, db: GatewayDatabase) -> None:
    """Register ``POST /v1/messages`` on the worker's outer app.

    Must run BEFORE the Experiential gateway app is mounted at ``/``: the root
    mount is a catch-all, and any route registered after it is unreachable.
    ``db`` is used only to enrich a spend-gated 429 with the verify-your-email
    message.
    """

    @app.post("/v1/messages")
    async def messages(request: Request) -> Response:
        """Serve one Anthropic Messages request through the chat surface."""
        return await handle_messages_request(service, request, db)

    @app.post("/v1/messages/count_tokens")
    async def count_tokens() -> Response:
        """Refuse token counting in the caller's own envelope.

        Claude Code (and wrappers like Conductor) probe this endpoint; the
        gateway has no tokenizer authority to answer truthfully, so it
        refuses explicitly in Anthropic shape instead of letting the root
        mount answer with an OpenAI-shaped 404 the client cannot parse.
        Claude Code falls back to its local estimate on failure.
        """
        msg = "count_tokens is not served by this gateway."
        return _error_response(AnthropicProtocolError(404, "not_found_error", msg))


async def handle_messages_request(
    service: GatewayService, request: Request, db: GatewayDatabase
) -> Response:
    """Authenticate, translate, dispatch, and re-encode one Messages request.

    Mirrors Experiential's ``_dispatch`` shape — every failure is sanitized at this
    boundary — but emits Anthropic envelopes. ``Idempotency-Key`` and
    ``X-Client-Request-Id`` are deliberately NOT honored here: the Anthropic
    protocol defines no idempotency header, and a caller operation on this
    route would share the chat_completions replay namespace with native
    OpenAI callers.
    """
    raw_key: str | None = None
    try:
        raw_key = _presented_key(
            request.headers.get("x-api-key"), request.headers.get("authorization")
        )
        service.authenticate(raw_key=raw_key)
        anthropic_request = decode_messages_request(await request.body())
        decoded = decode_chat(cast("JsonObject", to_chat_completions_body(anthropic_request)))
        upstream = await service.complete(raw_key=raw_key, decoded=decoded)
    except AnthropicProtocolError as error:
        return _error_response(error)
    except Exception as error:  # noqa: BLE001 - HTTP boundary sanitizes every failure
        return _error_response(await _translate_exception(error, db, raw_key))
    return _translate_upstream(anthropic_request, upstream)


def _presented_key(x_api_key: str | None, authorization: str | None) -> str:
    """Accept the Anthropic SDK's x-api-key or a standard Bearer credential."""
    if x_api_key is not None and x_api_key.strip():
        return x_api_key.strip()
    if authorization is not None and authorization.startswith("Bearer "):
        credential = authorization[len("Bearer ") :].strip()
        if credential:
            return credential
    msg = "A valid API key is required: send x-api-key or Authorization: Bearer."
    raise AnthropicProtocolError(401, "authentication_error", msg)


async def _translate_exception(
    error: Exception, db: GatewayDatabase, raw_key: str | None
) -> AnthropicProtocolError:
    """Route every gateway failure through Experiential's one OpenAI mapper, then translate.

    ``_exception_response`` is Experiential's single boundary authority for
    status and code; reusing it (private as it is) keeps this lane from ever
    drifting from what ``/v1/chat/completions`` would have answered. Before
    translating, a spend-gated ``insufficient_quota`` is enriched with the
    verify-your-email message when the org's founding admin is unverified — the
    same restoration the OpenAI lane's middleware performs, applied here on the
    OpenAI body so the Anthropic envelope carries the actionable reason too.
    """
    openai_response = _exception_response(error)
    try:
        body = json.loads(bytes(openai_response.body))
    except ValueError:
        body = {}
    if (
        raw_key is not None
        and is_insufficient_quota_envelope(body)
        and await asyncio.to_thread(org_owner_unverified_for_key, db, raw_key)
    ):
        body = apply_verify_email_notice(body)
    return translate_openai_error(openai_response.status_code, body)


def _translate_upstream(request: AnthropicMessagesRequest, upstream: Response) -> Response:
    """Re-encode the chat-surface response into Anthropic wire shape."""
    passthrough = {
        key: value for key, value in upstream.headers.items() if key.lower().startswith("x-")
    }
    if isinstance(upstream, StreamingResponse):
        return StreamingResponse(
            translate_chat_sse(request.model, upstream.body_iterator),
            status_code=upstream.status_code,
            media_type="text/event-stream",
            headers=passthrough,
        )
    try:
        body = json.loads(bytes(upstream.body))
    except ValueError:
        body = {}
    if upstream.status_code >= 400 or not isinstance(body, dict):
        translated = translate_openai_error(
            upstream.status_code, body if isinstance(body, dict) else {}
        )
        return _error_response(translated)
    return JSONResponse(translate_chat_completion(body), status_code=200, headers=passthrough)


def _error_response(error: AnthropicProtocolError) -> JSONResponse:
    """Serialize one Anthropic-enveloped error."""
    return JSONResponse(error.json_body(), status_code=error.status_code)
