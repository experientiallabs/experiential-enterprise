# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Unit tests for the inbound Anthropic Messages protocol adapter."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import cast

import pytest

from explabs.gateway.anthropic_messages import (
    AnthropicProtocolError,
    decode_messages_request,
    to_chat_completions_body,
    translate_chat_completion,
    translate_chat_sse,
    translate_openai_error,
)
from explabs.gateway.db import GatewayDatabase


def _decode(payload: dict) -> object:
    return decode_messages_request(json.dumps(payload).encode())


def _body(payload: dict) -> dict:
    request = decode_messages_request(json.dumps(payload).encode())
    return to_chat_completions_body(request)  # type: ignore[arg-type]


_MINIMAL = {
    "model": "claude-opus-5",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Hello"}],
}


# Request decode ---------------------------------------------------------------


def test_decode_rejects_non_json_and_non_object() -> None:
    """Decode rejects non json and non object."""
    with pytest.raises(AnthropicProtocolError) as excinfo:
        decode_messages_request(b"not json")
    assert excinfo.value.status_code == 400
    assert excinfo.value.error_type == "invalid_request_error"
    with pytest.raises(AnthropicProtocolError):
        decode_messages_request(b'["a list"]')


def test_decode_rejects_unknown_top_level_field_by_name() -> None:
    """Decode rejects unknown top level field by name."""
    with pytest.raises(AnthropicProtocolError) as excinfo:
        _decode({**_MINIMAL, "mcp_servers": []})
    assert "mcp_servers" in excinfo.value.message


def test_decode_requires_max_tokens() -> None:
    """Decode requires max tokens."""
    with pytest.raises(AnthropicProtocolError) as excinfo:
        _decode({"model": "m", "messages": [{"role": "user", "content": "hi"}]})
    assert "max_tokens" in excinfo.value.message


def test_decode_rejects_image_blocks_with_targeted_message() -> None:
    """Decode rejects image blocks with targeted message."""
    payload = {
        **_MINIMAL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "look:"},
                    {
                        "type": "image",
                        "source": {"type": "base64", "data": "...", "media_type": "image/png"},
                    },
                ],
            }
        ],
    }
    with pytest.raises(AnthropicProtocolError) as excinfo:
        _decode(payload)
    assert "text-only" in excinfo.value.message


def test_decode_rejects_image_inside_tool_result() -> None:
    """Decode rejects image inside tool result."""
    payload = {
        **_MINIMAL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": [{"type": "image", "source": {}}],
                    }
                ],
            }
        ],
    }
    with pytest.raises(AnthropicProtocolError) as excinfo:
        _decode(payload)
    assert "text-only" in excinfo.value.message


def test_decode_rejects_top_p_loudly() -> None:
    """Decode rejects top p loudly."""
    with pytest.raises(AnthropicProtocolError) as excinfo:
        _decode({**_MINIMAL, "top_p": 0.9})
    assert "top_p" in excinfo.value.message


# Request translation ----------------------------------------------------------


def test_minimal_request_translates_to_chat_body() -> None:
    """Minimal request translates to chat body."""
    body = _body(_MINIMAL)
    assert body == {
        "model": "claude-opus-5",
        "messages": [{"role": "user", "content": "Hello"}],
        "max_tokens": 512,
    }


def test_message_level_cache_control_is_accepted_and_dropped() -> None:
    """OpenCode sends cache_control on the message; drop it in translation."""
    expected = {
        "model": "claude-opus-5",
        "messages": [{"role": "user", "content": "Hello"}],
        "max_tokens": 512,
    }
    for annotation in (
        {"type": "ephemeral"},
        {"type": "ephemeral", "ttl": "5m"},
        {"type": "ephemeral", "ttl": "1h"},
    ):
        body = _body(
            {
                **_MINIMAL,
                "messages": [
                    {
                        "role": "user",
                        "content": "Hello",
                        "cache_control": annotation,
                    }
                ],
            }
        )
        assert body == expected
        assert "cache_control" not in json.dumps(body)


def test_message_level_cache_control_rejects_invalid_shape() -> None:
    """Decode rejects cache_control outside Anthropic's ephemeral shape."""
    for annotation in (
        {"type": "persistent"},
        {"type": "ephemeral", "ttl": "2h"},
        {"type": "ephemeral", "extra": True},
    ):
        with pytest.raises(AnthropicProtocolError) as excinfo:
            _decode(
                {
                    **_MINIMAL,
                    "messages": [
                        {
                            "role": "user",
                            "content": "Hello",
                            "cache_control": annotation,
                        }
                    ],
                }
            )
        assert excinfo.value.status_code == 400
        assert "cache_control" in excinfo.value.message


def test_system_string_and_block_array_become_system_message() -> None:
    """System string and block array become system message."""
    as_string = _body({**_MINIMAL, "system": "Be brief."})
    assert as_string["messages"][0] == {"role": "system", "content": "Be brief."}
    as_blocks = _body(
        {
            **_MINIMAL,
            "system": [
                {"type": "text", "text": "Be brief."},
                {"type": "text", "text": "Be kind.", "cache_control": {"type": "ephemeral"}},
            ],
        }
    )
    # Parts join with a blank line, mirroring wmo's outbound flattening, and
    # cache_control annotations drop.
    assert as_blocks["messages"][0] == {"role": "system", "content": "Be brief.\n\nBe kind."}


def test_thinking_config_and_history_blocks_are_dropped() -> None:
    """Thinking config and history blocks are dropped."""
    body = _body(
        {
            **_MINIMAL,
            "thinking": {"type": "enabled", "budget_tokens": 2048},
            "messages": [
                {"role": "user", "content": "hi"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": "hmm", "signature": "sig"},
                        {"type": "text", "text": "Hello!"},
                    ],
                },
                {"role": "user", "content": "continue"},
            ],
        }
    )
    assert "thinking" not in json.dumps(body)
    assert body["messages"][1] == {"role": "assistant", "content": "Hello!"}


def test_tool_use_becomes_assistant_tool_calls_with_json_string_arguments() -> None:
    """Tool use becomes assistant tool calls with json string arguments."""
    body = _body(
        {
            **_MINIMAL,
            "messages": [
                {"role": "user", "content": "read a file"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Reading."},
                        {
                            "type": "tool_use",
                            "id": "toolu_1",
                            "name": "read_file",
                            "input": {"path": "a.py"},
                        },
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "toolu_1", "content": "print(1)"},
                        {"type": "text", "text": "now explain"},
                    ],
                },
            ],
        }
    )
    assistant = body["messages"][1]
    assert assistant["content"] == "Reading."
    assert assistant["tool_calls"] == [
        {
            "id": "toolu_1",
            "type": "function",
            "function": {"name": "read_file", "arguments": '{"path": "a.py"}'},
        }
    ]
    # The tool_result splits into a standalone tool message, then the text
    # continues as a user message, in order.
    assert body["messages"][2] == {
        "role": "tool",
        "tool_call_id": "toolu_1",
        "content": "print(1)",
    }
    assert body["messages"][3] == {"role": "user", "content": "now explain"}


def test_tool_result_array_content_flattens_and_is_error_drops() -> None:
    """Tool result array content flattens and is error drops."""
    body = _body(
        {
            **_MINIMAL,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_9",
                            "content": [{"type": "text", "text": "boom"}],
                            "is_error": True,
                        }
                    ],
                }
            ],
        }
    )
    assert body["messages"][0] == {"role": "tool", "tool_call_id": "toolu_9", "content": "boom"}


def test_tool_blocks_enforce_role_placement() -> None:
    """Tool blocks enforce role placement."""
    with pytest.raises(AnthropicProtocolError):
        _body(
            {
                **_MINIMAL,
                "messages": [
                    {
                        "role": "user",
                        "content": [{"type": "tool_use", "id": "t", "name": "n", "input": {}}],
                    }
                ],
            }
        )
    with pytest.raises(AnthropicProtocolError):
        _body(
            {
                **_MINIMAL,
                "messages": [
                    {
                        "role": "assistant",
                        "content": [{"type": "tool_result", "tool_use_id": "t"}],
                    }
                ],
            }
        )


def test_tools_and_tool_choice_translate() -> None:
    """Tools and tool choice translate."""
    base = {
        **_MINIMAL,
        "tools": [
            {
                "name": "bash",
                "description": "Run a command",
                "input_schema": {"type": "object", "properties": {"cmd": {"type": "string"}}},
            }
        ],
    }
    body = _body({**base, "tool_choice": {"type": "any", "disable_parallel_tool_use": True}})
    assert body["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "bash",
                "description": "Run a command",
                "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}},
            },
        }
    ]
    assert body["tool_choice"] == "required"
    assert body["parallel_tool_calls"] is False
    named = _body({**base, "tool_choice": {"type": "tool", "name": "bash"}})
    assert named["tool_choice"] == {"type": "function", "function": {"name": "bash"}}
    assert _body({**base, "tool_choice": {"type": "auto"}})["tool_choice"] == "auto"
    assert _body({**base, "tool_choice": {"type": "none"}})["tool_choice"] == "none"


def test_stop_sequences_dedupe_and_reject_empty() -> None:
    """Stop sequences dedupe and reject empty."""
    body = _body({**_MINIMAL, "stop_sequences": ["END", "STOP", "END"]})
    assert body["stop"] == ["END", "STOP"]
    with pytest.raises(AnthropicProtocolError):
        _body({**_MINIMAL, "stop_sequences": [""]})


def test_stream_adds_include_usage() -> None:
    """Stream adds include usage."""
    body = _body({**_MINIMAL, "stream": True})
    assert body["stream"] is True
    assert body["stream_options"] == {"include_usage": True}


def test_metadata_user_id_passes_through() -> None:
    """Metadata user id passes through."""
    body = _body({**_MINIMAL, "metadata": {"user_id": "u-1"}})
    assert body["metadata"] == {"user_id": "u-1"}


# Response translation ----------------------------------------------------------


def _chat_response(**overrides: object) -> dict:
    base: dict = {
        "id": "chatcmpl_abc",
        "object": "chat.completion",
        "created": 1,
        "model": "claude-opus-5",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "Hi!",
                    "refusal": None,
                    "tool_calls": None,
                },
                "finish_reason": "stop",
                "logprobs": None,
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 4},
    }
    base.update(overrides)
    return base


def test_text_completion_translates_to_message() -> None:
    """Text completion translates to message."""
    message = translate_chat_completion(_chat_response())
    assert message["id"].startswith("msg_")
    assert message["type"] == "message"
    assert message["role"] == "assistant"
    assert message["model"] == "claude-opus-5"
    assert message["content"] == [{"type": "text", "text": "Hi!"}]
    assert message["stop_reason"] == "end_turn"
    assert message["stop_sequence"] is None
    assert message["usage"] == {"input_tokens": 10, "output_tokens": 4}


def test_tool_calls_translate_to_tool_use_blocks() -> None:
    """Tool calls translate to tool use blocks."""
    response = _chat_response()
    response["choices"][0]["message"]["content"] = None
    response["choices"][0]["message"]["tool_calls"] = [
        {
            "id": "call_1",
            "type": "function",
            "function": {"name": "bash", "arguments": '{"cmd": "ls"}'},
        }
    ]
    response["choices"][0]["finish_reason"] = "tool_calls"
    message = translate_chat_completion(response)
    assert message["content"] == [
        {"type": "tool_use", "id": "call_1", "name": "bash", "input": {"cmd": "ls"}}
    ]
    assert message["stop_reason"] == "tool_use"


def test_length_finish_reason_maps_to_max_tokens() -> None:
    """Length finish reason maps to max tokens."""
    response = _chat_response()
    response["choices"][0]["finish_reason"] = "length"
    assert translate_chat_completion(response)["stop_reason"] == "max_tokens"


def test_cached_tokens_recover_cache_read_counter() -> None:
    """Cached tokens recover cache read counter."""
    response = _chat_response(
        usage={
            "prompt_tokens": 100,
            "completion_tokens": 5,
            "prompt_tokens_details": {"cached_tokens": 60},
        }
    )
    assert translate_chat_completion(response)["usage"] == {
        "input_tokens": 40,
        "output_tokens": 5,
        "cache_read_input_tokens": 60,
    }


def test_refusal_surfaces_as_error() -> None:
    """Refusal surfaces as error."""
    response = _chat_response()
    response["choices"][0]["message"]["refusal"] = "no"
    with pytest.raises(AnthropicProtocolError) as excinfo:
        translate_chat_completion(response)
    assert excinfo.value.status_code == 502


# Error envelope ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "openai_type", "expected"),
    [
        (400, "invalid_request_error", "invalid_request_error"),
        (401, "authentication_error", "authentication_error"),
        (403, "permission_error", "permission_error"),
        (404, "invalid_request_error", "not_found_error"),
        (429, "insufficient_quota", "rate_limit_error"),
        (429, "api_error", "rate_limit_error"),
        (500, "api_error", "api_error"),
        (502, "api_error", "api_error"),
        (503, "api_error", "overloaded_error"),
        (504, "api_error", "api_error"),
    ],
)
def test_error_type_mapping(status: int, openai_type: str, expected: str) -> None:
    """Error type mapping."""
    translated = translate_openai_error(
        status, {"error": {"message": "m", "type": openai_type, "code": "c", "param": None}}
    )
    assert translated.status_code == status
    assert translated.error_type == expected
    assert translated.json_body() == {"type": "error", "error": {"type": expected, "message": "m"}}


def test_error_param_folds_into_message() -> None:
    """Error param folds into message."""
    translated = translate_openai_error(
        400,
        {
            "error": {
                "message": "Invalid value.",
                "type": "invalid_request_error",
                "code": "invalid_parameter",
                "param": "messages.0.content",
            }
        },
    )
    assert "messages.0.content" in translated.message


# Streaming translation ----------------------------------------------------------


def _chat_frames(*payloads: object) -> list[bytes]:
    frames = [f"data: {json.dumps(payload)}\n\n".encode() for payload in payloads]
    frames.append(b"data: [DONE]\n\n")
    return frames


def _chunk(delta: dict, finish_reason: str | None = None) -> dict:
    return {
        "id": "chatcmpl_abc",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "claude-opus-5",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason, "logprobs": None}],
    }


async def _byte_stream(frames: list[bytes], split: int | None = None) -> AsyncIterator[bytes]:
    raw = b"".join(frames)
    if split is None:
        for frame in frames:
            yield frame
    else:
        for start in range(0, len(raw), split):
            yield raw[start : start + split]


async def _translate(frames: list[bytes], split: int | None = None) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    async for event in translate_chat_sse("claude-opus-5", _byte_stream(frames, split)):
        text = event.decode()
        assert text.startswith("event: ")
        assert text.endswith("\n\n")
        name, _, data_line = text.strip().partition("\n")
        events.append((name[len("event: ") :], json.loads(data_line[len("data: ") :])))
    return events


def _usage_chunk() -> dict:
    return {
        "id": "chatcmpl_abc",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "claude-opus-5",
        "choices": [],
        "usage": {
            "prompt_tokens": 7,
            "completion_tokens": 3,
            "prompt_tokens_details": {"cached_tokens": 0},
            "completion_tokens_details": {"reasoning_tokens": 0},
        },
    }


async def test_text_stream_translates_to_anthropic_event_grammar() -> None:
    """Text stream translates to anthropic event grammar."""
    events = await _translate(
        _chat_frames(
            _chunk({"role": "assistant"}),
            _chunk({"content": "Hel"}),
            _chunk({"content": "lo"}),
            _chunk({}, finish_reason="stop"),
            _usage_chunk(),
        )
    )
    names = [name for name, _ in events]
    assert names == [
        "message_start",
        "ping",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
    ]
    start = events[0][1]["message"]
    assert start["id"].startswith("msg_")
    assert start["model"] == "claude-opus-5"
    assert start["usage"] == {"input_tokens": 0, "output_tokens": 0}
    assert events[2][1]["content_block"] == {"type": "text", "text": ""}
    assert events[3][1]["delta"] == {"type": "text_delta", "text": "Hel"}
    final = events[6][1]
    assert final["delta"] == {"stop_reason": "end_turn", "stop_sequence": None}
    assert final["usage"] == {"input_tokens": 7, "output_tokens": 3}


async def test_stream_survives_arbitrary_byte_chunking() -> None:
    """Stream survives arbitrary byte chunking."""
    frames = _chat_frames(
        _chunk({"role": "assistant"}),
        _chunk({"content": "Hi"}),
        _chunk({}, finish_reason="stop"),
        _usage_chunk(),
    )
    expected_names = [name for name, _ in await _translate(frames)]
    for split in (1, 3, 7):
        events = await _translate(frames, split=split)
        assert [name for name, _ in events] == expected_names
        text = "".join(
            payload["delta"]["text"] for name, payload in events if name == "content_block_delta"
        )
        assert text == "Hi"


async def test_tool_call_stream_translates_to_tool_use_blocks() -> None:
    """Tool call stream translates to tool use blocks."""
    events = await _translate(
        _chat_frames(
            _chunk({"role": "assistant"}),
            _chunk({"content": "Let me check."}),
            _chunk(
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "bash", "arguments": ""},
                        }
                    ]
                }
            ),
            _chunk({"tool_calls": [{"index": 0, "function": {"arguments": '{"cmd":'}}]}),
            _chunk({"tool_calls": [{"index": 0, "function": {"arguments": ' "ls"}'}}]}),
            _chunk({}, finish_reason="tool_calls"),
            _usage_chunk(),
        )
    )
    names = [name for name, _ in events]
    assert names == [
        "message_start",
        "ping",
        "content_block_start",  # text
        "content_block_delta",
        "content_block_stop",
        "content_block_start",  # tool_use
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
    ]
    tool_start = events[5][1]
    assert tool_start["index"] == 1
    assert tool_start["content_block"] == {
        "type": "tool_use",
        "id": "call_1",
        "name": "bash",
        "input": {},
    }
    assert events[6][1]["delta"] == {"type": "input_json_delta", "partial_json": '{"cmd":'}
    assert events[9][1]["delta"]["stop_reason"] == "tool_use"


async def test_mid_stream_error_frame_becomes_error_event() -> None:
    """Mid stream error frame becomes error event."""
    frames = [
        f"data: {json.dumps(_chunk({'role': 'assistant'}))}\n\n".encode(),
        f"data: {json.dumps(_chunk({'content': 'par'}))}\n\n".encode(),
        b'data: {"error": {"message": "route died", "type": "api_error", "code": "all_routes_failed", "param": null}}\n\n',
        b"data: [DONE]\n\n",
    ]
    events = await _translate(frames)
    assert events[-1][0] == "error"
    assert events[-1][1] == {
        "type": "error",
        "error": {"type": "api_error", "message": "route died"},
    }
    # No message_stop after a terminal error.
    assert "message_stop" not in [name for name, _ in events]


async def test_truncated_stream_ends_with_an_error_event_not_a_clean_finale() -> None:
    """A stream that dies before [DONE] must not masquerade as complete."""
    frames = [
        f"data: {json.dumps(_chunk({'role': 'assistant'}))}\n\n".encode(),
        f"data: {json.dumps(_chunk({'content': 'par'}))}\n\n".encode(),
        # No terminal frame: the upstream socket died mid-stream.
    ]
    events = await _translate(frames)
    names = [name for name, _ in events]
    assert names[-1] == "error"
    assert events[-1][1]["error"]["type"] == "api_error"
    assert "message_stop" not in names
    assert "message_delta" not in names


async def test_empty_stream_still_produces_a_complete_message_shape() -> None:
    """Empty stream still produces a complete message shape."""
    events = await _translate([b"data: [DONE]\n\n"])
    names = [name for name, _ in events]
    assert names == ["message_start", "message_delta", "message_stop"]


# Email-verification spend-gate enrichment on the Anthropic lane ---------------


@pytest.mark.asyncio
async def test_translate_exception_enriches_quota_for_unverified_org(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A spend-gated 429 on /v1/messages carries the verify-your-email reason."""
    import json as _json

    from exp.runtime.gateway.contracts import GatewayFailure, GatewayFailureClass
    from exp.runtime.gateway.execution import GatewayExecutionError

    from explabs.gateway import anthropic_messages as adapter
    from explabs.gateway.verification_notice import VERIFY_EMAIL_MESSAGE

    monkeypatch.setattr(adapter, "org_owner_unverified_for_key", lambda _db, _key: True)  # type: ignore[attr-defined]
    error = GatewayExecutionError(
        GatewayFailure(
            failure_class=GatewayFailureClass.QUOTA_EXCEEDED,
            safe_message="monthly gateway allocation is exhausted",
        )
    )
    translated = await adapter._translate_exception(  # noqa: SLF001
        error, db=cast("GatewayDatabase", None), raw_key="xpl_x"
    )
    body = _json.dumps(translated.json_body())
    assert VERIFY_EMAIL_MESSAGE in body


@pytest.mark.asyncio
async def test_translate_exception_leaves_verified_org_quota_generic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A verified org's Anthropic 429 keeps the generic exhausted message."""
    import json as _json

    from exp.runtime.gateway.contracts import GatewayFailure, GatewayFailureClass
    from exp.runtime.gateway.execution import GatewayExecutionError

    from explabs.gateway import anthropic_messages as adapter
    from explabs.gateway.verification_notice import VERIFY_EMAIL_MESSAGE

    monkeypatch.setattr(adapter, "org_owner_unverified_for_key", lambda _db, _key: False)  # type: ignore[attr-defined]
    error = GatewayExecutionError(
        GatewayFailure(
            failure_class=GatewayFailureClass.QUOTA_EXCEEDED,
            safe_message="monthly gateway allocation is exhausted",
        )
    )
    translated = await adapter._translate_exception(  # noqa: SLF001
        error, db=cast("GatewayDatabase", None), raw_key="xpl_x"
    )
    body = _json.dumps(translated.json_body())
    assert VERIFY_EMAIL_MESSAGE not in body
    assert "exhausted" in body
