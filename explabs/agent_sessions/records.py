# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Typed parsers for local Codex and Claude Code session logs.

The single source of truth for reading coding-agent session logs on a
tenant's machine. Both consumers — the historical-spend importer
(``scripts/import_local_ai_spend.py``) and the per-session usage report
(``explabs.agent_sessions.cli``) — parse through this module, so the two
surfaces cannot drift on field mappings or token normalization.

PRIVACY: parsing reads usage METADATA ONLY — model ids, token counts,
timestamps, session/workspace identifiers, and plan rate-limit state. It
never reads, stores, or yields any prompt, response, tool argument, or other
message content, and it never touches ``~/.codex/history.jsonl`` (which
holds prompt text).

Sources and the fields read (metadata only):
  * Claude Code — ``~/.claude/projects/**/*.jsonl``. Each
    ``type == "assistant"`` line carries ``message.model`` and
    ``message.usage.{input_tokens, output_tokens, cache_read_input_tokens,
    cache_creation_input_tokens, output_tokens_details.thinking_tokens}``;
    the line's top-level ``timestamp`` dates the turn. Streaming appends the
    same API response as several lines sharing one ``message.id``, so turns
    dedupe on that id.
  * Codex — ``~/.codex/sessions/**/*.jsonl`` rollouts. ``session_meta``
    lines carry the session id and workspace, ``turn_context`` lines the
    active model, and token-count ``event_msg`` lines the per-call delta
    (``payload.info.last_token_usage``) plus the plan rate-limit window
    Codex last observed (``payload.rate_limits.primary``).

Token counts are normalized to the import endpoint's convention:
``input_tokens`` is fresh non-cached input, ``cached_tokens`` is cached
input, ``output_tokens`` includes reasoning, and ``reasoning_tokens`` is the
reasoning subset, display only. Claude Code counts cache WRITES outside its
``input_tokens`` (fresh input is ``input_tokens +
cache_creation_input_tokens``); Codex counts cached READS inside its
``input_tokens`` (fresh input is ``input_tokens - cached_input_tokens``).
Getting either wrong double-counts, so the two rules live here only.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from explabs.db.stores.gateway_imported_usage_store import ImportSource


class ClaudeTokenDetails(BaseModel):
    """The ``output_tokens_details`` block of a Claude Code usage record."""

    model_config = ConfigDict(frozen=True)

    thinking_tokens: int = Field(default=0, ge=0)


class ClaudeUsage(BaseModel):
    """Token counts on one Claude Code assistant transcript line."""

    model_config = ConfigDict(frozen=True)

    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cache_read_input_tokens: int = Field(default=0, ge=0)
    cache_creation_input_tokens: int = Field(default=0, ge=0)
    output_tokens_details: ClaudeTokenDetails = Field(default_factory=ClaudeTokenDetails)


class ClaudeMessage(BaseModel):
    """The API-response envelope on a Claude Code assistant line."""

    model_config = ConfigDict(frozen=True)

    id: str | None = None
    model: str | None = None
    usage: ClaudeUsage | None = None


class ClaudeAssistantLine(BaseModel):
    """One ``type == "assistant"`` transcript line — the usage-bearing record.

    A failed API call is also an assistant line: ``isApiErrorMessage`` is
    true, ``error`` names the failure kind (a short enum-like string such as
    ``rate_limit`` or ``server_error``), and the model is ``<synthetic>``.
    Those lines are the local limit-hit signal.
    """

    model_config = ConfigDict(frozen=True, populate_by_name=True)

    message: ClaudeMessage = Field(default_factory=ClaudeMessage)
    timestamp: str | None = None
    line_uuid: str | None = Field(default=None, alias="uuid")
    session_id: str | None = Field(default=None, alias="sessionId")
    cwd: str | None = None
    git_branch: str | None = Field(default=None, alias="gitBranch")
    is_api_error: bool = Field(default=False, alias="isApiErrorMessage")
    error: str | None = None


class CodexSessionMetaPayload(BaseModel):
    """The payload of a Codex ``session_meta`` rollout line."""

    model_config = ConfigDict(frozen=True)

    id: str | None = None
    session_id: str | None = None
    cwd: str | None = None


class CodexTurnContextPayload(BaseModel):
    """The payload of a Codex ``turn_context`` line (the active model)."""

    model_config = ConfigDict(frozen=True)

    model: str | None = None


class CodexTokenUsage(BaseModel):
    """One Codex API call's token delta (``last_token_usage``)."""

    model_config = ConfigDict(frozen=True)

    input_tokens: int = Field(default=0, ge=0)
    cached_input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    reasoning_output_tokens: int = Field(default=0, ge=0)


class CodexTokenInfo(BaseModel):
    """The ``info`` block of a token-count event; null between real calls."""

    model_config = ConfigDict(frozen=True)

    last_token_usage: CodexTokenUsage | None = None


class CodexRateLimitWindow(BaseModel):
    """One plan rate-limit window as the Codex backend reported it."""

    model_config = ConfigDict(frozen=True)

    used_percent: float | None = None
    window_minutes: int | None = None
    resets_at: int | None = None


class CodexCredits(BaseModel):
    """Plan credit state on the rate-limits block.

    ``balance`` is deliberately not modeled yet: it has been null in every
    observed event, so its wire type is unknown and a wrong guess would
    invalidate the whole usage record.
    """

    model_config = ConfigDict(frozen=True)

    has_credits: bool | None = None
    unlimited: bool | None = None


class CodexRateLimits(BaseModel):
    """The ``rate_limits`` block riding on Codex token-count events.

    Older CLIs report the 5-hour window as ``primary`` with the weekly
    window as ``secondary``; newer CLIs report the weekly window as
    ``primary`` alone — consumers must read both. ``rate_limit_reached_type``
    is null until the backend rejects a call for the limit, which makes it
    the explicit switch-now signal.
    """

    model_config = ConfigDict(frozen=True)

    limit_id: str | None = None
    plan_type: str | None = None
    primary: CodexRateLimitWindow | None = None
    secondary: CodexRateLimitWindow | None = None
    credits: CodexCredits | None = None
    rate_limit_reached_type: str | None = None
    spend_control_reached: bool | None = None


class CodexTokenCountPayload(BaseModel):
    """An ``event_msg`` payload; only ``type == "token_count"`` carries usage."""

    model_config = ConfigDict(frozen=True)

    type: str | None = None
    info: CodexTokenInfo | None = None
    rate_limits: CodexRateLimits | None = None
    turn_id: str | None = None


@dataclass(frozen=True, slots=True)
class TurnUsage:
    """One API call's usage, normalized to the import-endpoint convention.

    ``event_id`` is the log's native stable per-turn id (Claude Code message
    id, Codex session + turn ordinal) and must stay byte-identical across
    releases: the import endpoint folds it into the server-side dedupe hash.
    """

    source: ImportSource
    event_id: str
    model: str
    input_tokens: int
    cached_tokens: int
    output_tokens: int
    reasoning_tokens: int
    timestamp: str


@dataclass(frozen=True, slots=True)
class WindowState:
    """One rate-limit window's consumption at an observation instant."""

    used_percent: float | None
    window_minutes: int | None
    resets_at_epoch: int | None


@dataclass(frozen=True, slots=True)
class CodexLimitObservation:
    """The Codex plan limit state as of a session's last API call.

    ``limit_reached`` mirrors ``rate_limit_reached_type``: null until the
    backend rejects a call for the limit — the explicit switch-now signal.
    """

    limit_id: str | None
    plan_type: str | None
    primary: WindowState | None
    secondary: WindowState | None
    has_credits: bool | None
    limit_reached: str | None
    spend_control_reached: bool | None
    observed_at: str


@dataclass(frozen=True, slots=True)
class ApiErrorEvent:
    """One failed API call in a Claude Code transcript (kind only, no text)."""

    kind: str
    timestamp: str


@dataclass(frozen=True, slots=True)
class SessionFileScan:
    """Usage metadata read from one session log file — never content.

    ``file_stem`` identifies the scanned file: Codex ordinal event ids are
    only unique within one rollout file (sibling threads reuse a session id
    with their own counters), so aggregation scopes them by file.
    """

    source: ImportSource
    session_id: str
    file_stem: str
    project_dir: str | None
    git_branch: str | None
    turns: tuple[TurnUsage, ...]
    limit_observation: CodexLimitObservation | None
    api_errors: tuple[ApiErrorEvent, ...]


# Cheap substring pre-filters so multi-gigabyte transcripts skip json.loads
# on the (dominant) lines that cannot carry usage. A false positive — the
# marker appearing inside another record — is caught by the typed check on
# the parsed record; a marker can't be missing from a real match because
# JSONL never escapes ASCII keys.
_CLAUDE_ASSISTANT_MARKERS = ('"type":"assistant"', '"type": "assistant"')
_CODEX_LINE_MARKERS = ('"session_meta"', '"turn_context"', '"token_count"')


def _iter_raw_lines(path: Path) -> Iterator[str]:
    """Yield non-empty lines; an unreadable or vanished file yields nothing."""
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip()
                if stripped:
                    yield stripped
    except OSError:
        return


def _parse_json_object(raw: str) -> dict[str, object] | None:
    """Parse one JSONL line into an object; None for anything else."""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _validate[ModelT: BaseModel](model_type: type[ModelT], payload: object) -> ModelT | None:
    """Validate one raw JSON value into a typed line model, or None."""
    if not isinstance(payload, dict):
        return None
    try:
        return model_type.model_validate(payload)
    except ValidationError:
        return None


def _claude_turn(line: ClaudeAssistantLine, *, fallback_id: str) -> TurnUsage | None:
    """Normalize one assistant line to a usage turn, or None without usage."""
    usage = line.message.usage
    model = line.message.model
    if usage is None or model is None or line.timestamp is None:
        return None
    fresh_input = usage.input_tokens + usage.cache_creation_input_tokens
    cached = usage.cache_read_input_tokens
    if fresh_input + cached + usage.output_tokens == 0:
        return None
    event_id = line.message.id or line.line_uuid or fallback_id
    return TurnUsage(
        source=ImportSource.CLAUDE_CODE,
        event_id=event_id,
        model=model,
        input_tokens=fresh_input,
        cached_tokens=cached,
        output_tokens=usage.output_tokens,
        reasoning_tokens=usage.output_tokens_details.thinking_tokens,
        timestamp=line.timestamp,
    )


def scan_claude_file(path: Path) -> SessionFileScan:
    """Scan one Claude Code transcript into per-turn usage (metadata only).

    One transcript file is one session. Workspace metadata (session id, cwd,
    git branch) comes from the first assistant line that carries it; the
    session id falls back to the file stem, which Claude Code names after
    the session uuid.
    """
    session_id = path.stem
    project_dir: str | None = None
    git_branch: str | None = None
    # Streaming rewrites one API response as several lines with the same
    # message id and GROWING usage; the last line carries the final counts,
    # so a later chunk replaces the earlier one.
    turns_by_id: dict[str, TurnUsage] = {}
    api_errors: list[ApiErrorEvent] = []
    for index, raw in enumerate(_iter_raw_lines(path)):
        if not any(marker in raw for marker in _CLAUDE_ASSISTANT_MARKERS):
            continue
        parsed = _parse_json_object(raw)
        if parsed is None or parsed.get("type") != "assistant":
            continue
        line = _validate(ClaudeAssistantLine, parsed)
        if line is None:
            continue
        if line.session_id is not None:
            session_id = line.session_id
        if project_dir is None:
            project_dir = line.cwd
        if git_branch is None:
            git_branch = line.git_branch
        if line.is_api_error and line.timestamp is not None:
            api_errors.append(ApiErrorEvent(kind=line.error or "unknown", timestamp=line.timestamp))
        turn = _claude_turn(line, fallback_id=f"{path.name}:{index}")
        if turn is not None:
            turns_by_id[turn.event_id] = turn
    return SessionFileScan(
        source=ImportSource.CLAUDE_CODE,
        session_id=session_id,
        file_stem=path.stem,
        project_dir=project_dir,
        git_branch=git_branch,
        turns=tuple(turns_by_id.values()),
        limit_observation=None,
        api_errors=tuple(api_errors),
    )


def _codex_turn(
    token: CodexTokenCountPayload,
    *,
    model: str | None,
    timestamp: str,
    fallback_id: str,
) -> TurnUsage | None:
    """Build one Codex usage turn from a token-count payload, or None."""
    if model is None or token.info is None or token.info.last_token_usage is None:
        return None
    last = token.info.last_token_usage
    cached = last.cached_input_tokens
    fresh_input = max(last.input_tokens - cached, 0)
    if fresh_input + cached + last.output_tokens == 0:
        return None
    return TurnUsage(
        source=ImportSource.CODEX,
        event_id=token.turn_id or fallback_id,
        model=model,
        input_tokens=fresh_input,
        cached_tokens=cached,
        output_tokens=last.output_tokens,
        reasoning_tokens=last.reasoning_output_tokens,
        timestamp=timestamp,
    )


@dataclass(slots=True)
class _CodexScanState:
    """Mutable fold state while scanning one Codex rollout file."""

    session_id: str
    project_dir: str | None = None
    current_model: str | None = None
    turn_index: int = 0
    turns: list[TurnUsage] = field(default_factory=list)
    limit_observation: CodexLimitObservation | None = None

    def apply(self, parsed: dict[str, object]) -> None:
        """Fold one parsed rollout line into the state."""
        match parsed.get("type"):
            case "session_meta":
                self._apply_meta(parsed.get("payload"))
            case "turn_context":
                self._apply_context(parsed.get("payload"))
            case "event_msg":
                self._apply_event(parsed)
            case _:
                return

    def _apply_meta(self, payload: object) -> None:
        """Take the session id and workspace from a ``session_meta`` line."""
        meta = _validate(CodexSessionMetaPayload, payload)
        if meta is None:
            return
        self.session_id = meta.session_id or meta.id or self.session_id
        if self.project_dir is None:
            self.project_dir = meta.cwd

    def _apply_context(self, payload: object) -> None:
        """Track the active model from a ``turn_context`` line."""
        context = _validate(CodexTurnContextPayload, payload)
        if context is not None and context.model is not None:
            self.current_model = context.model

    def _apply_event(self, parsed: dict[str, object]) -> None:
        """Take one turn and the plan window from a token-count event."""
        token = _validate(CodexTokenCountPayload, parsed.get("payload"))
        timestamp = parsed.get("timestamp")
        if token is None or token.type != "token_count" or not isinstance(timestamp, str):
            return
        if token.rate_limits is not None:
            self.limit_observation = _limit_observation(token.rate_limits, observed_at=timestamp)
        turn = _codex_turn(
            token,
            model=self.current_model,
            timestamp=timestamp,
            fallback_id=f"{self.session_id}:{self.turn_index}",
        )
        if turn is not None:
            self.turn_index += 1
            self.turns.append(turn)


def scan_codex_file(path: Path) -> SessionFileScan:
    """Scan one Codex rollout into per-turn usage (metadata only).

    A small state machine over the rollout's line types: ``session_meta``
    names the session, ``turn_context`` tracks the active model, and each
    token-count ``event_msg`` contributes one turn plus the latest plan
    rate-limit observation. Resuming a session appends to the same rollout
    file, so one file is one session.
    """
    state = _CodexScanState(session_id=path.stem)
    for raw in _iter_raw_lines(path):
        if not any(marker in raw for marker in _CODEX_LINE_MARKERS):
            continue
        parsed = _parse_json_object(raw)
        if parsed is not None:
            state.apply(parsed)
    return SessionFileScan(
        source=ImportSource.CODEX,
        session_id=state.session_id,
        file_stem=path.stem,
        project_dir=state.project_dir,
        git_branch=None,
        turns=tuple(state.turns),
        limit_observation=state.limit_observation,
        api_errors=(),
    )


def _window_state(window: CodexRateLimitWindow | None) -> WindowState | None:
    """Snapshot one reported rate-limit window, or None when absent."""
    if window is None:
        return None
    return WindowState(
        used_percent=window.used_percent,
        window_minutes=window.window_minutes,
        resets_at_epoch=window.resets_at,
    )


def _limit_observation(limits: CodexRateLimits, *, observed_at: str) -> CodexLimitObservation:
    """Snapshot the full plan-limit state riding on one token-count event."""
    return CodexLimitObservation(
        limit_id=limits.limit_id,
        plan_type=limits.plan_type,
        primary=_window_state(limits.primary),
        secondary=_window_state(limits.secondary),
        has_credits=limits.credits.has_credits if limits.credits is not None else None,
        limit_reached=limits.rate_limit_reached_type,
        spend_control_reached=limits.spend_control_reached,
        observed_at=observed_at,
    )


def scan_claude_root(root: Path) -> Iterator[SessionFileScan]:
    """Scan every Claude Code transcript under ``root``, one scan per file."""
    for path in sorted(root.rglob("*.jsonl")):
        yield scan_claude_file(path)


def scan_codex_root(root: Path) -> Iterator[SessionFileScan]:
    """Scan every Codex rollout under ``root``, one scan per file."""
    for path in sorted(root.rglob("*.jsonl")):
        yield scan_codex_file(path)


def collect_turns(claude_root: Path, codex_root: Path) -> list[TurnUsage]:
    """Gather per-turn usage from both local stores; absent roots are skipped."""
    turns: list[TurnUsage] = []
    if claude_root.exists():
        for scan in scan_claude_root(claude_root):
            turns.extend(scan.turns)
    if codex_root.exists():
        for scan in scan_codex_root(codex_root):
            turns.extend(scan.turns)
    return turns
