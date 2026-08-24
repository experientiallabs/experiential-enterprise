# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Shared fixtures: synthetic session-log trees shaped like the real stores.

The builders emit usage METADATA only — model ids, token counts, timestamps —
mirroring the exact line shapes `records.py` parses, so tests never need (and
never contain) transcript content.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest

type JsonLine = dict[str, object]
type LineBuilder = Callable[..., JsonLine]


@pytest.fixture
def claude_root(tmp_path: Path) -> Path:
    """An empty Claude Code projects tree."""
    root = tmp_path / "claude-projects"
    root.mkdir()
    return root


@pytest.fixture
def codex_root(tmp_path: Path) -> Path:
    """An empty Codex sessions tree."""
    root = tmp_path / "codex-sessions"
    root.mkdir()
    return root


@pytest.fixture
def write_claude_session(claude_root: Path) -> Callable[..., Path]:
    """Write one Claude Code transcript file from prepared lines."""

    def _write(session_id: str, lines: list[JsonLine], *, project: str = "-work-demo") -> Path:
        directory = claude_root / project
        directory.mkdir(exist_ok=True)
        path = directory / f"{session_id}.jsonl"
        path.write_text("".join(f"{json.dumps(line)}\n" for line in lines), encoding="utf-8")
        return path

    return _write


@pytest.fixture
def write_codex_session(codex_root: Path) -> Callable[..., Path]:
    """Write one Codex rollout file from prepared lines."""

    def _write(file_stem: str, lines: list[JsonLine]) -> Path:
        directory = codex_root / "2026" / "08" / "01"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{file_stem}.jsonl"
        path.write_text("".join(f"{json.dumps(line)}\n" for line in lines), encoding="utf-8")
        return path

    return _write


@pytest.fixture
def claude_assistant_line() -> LineBuilder:
    """Build one assistant transcript line with overridable usage metadata."""

    def _line(
        *,
        message_id: str | None = "msg_001",
        line_uuid: str | None = "uuid-001",
        model: str | None = "claude-fable-5",
        timestamp: str | None = "2026-08-01T10:00:00.000Z",
        session_id: str | None = "11111111-2222-4333-8444-555555555555",
        cwd: str | None = "/work/demo",
        git_branch: str | None = "main",
        input_tokens: int = 2,
        output_tokens: int = 40,
        cache_read: int = 100,
        cache_write: int = 30,
        thinking: int = 7,
        api_error: str | None = None,
    ) -> JsonLine:
        message: JsonLine = {
            "model": model,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_write,
                "output_tokens_details": {"thinking_tokens": thinking},
            },
        }
        if message_id is not None:
            message["id"] = message_id
        line: JsonLine = {"type": "assistant", "message": message}
        if api_error is not None:
            line["isApiErrorMessage"] = True
            line["error"] = api_error
        for key, value in (
            ("timestamp", timestamp),
            ("uuid", line_uuid),
            ("sessionId", session_id),
            ("cwd", cwd),
            ("gitBranch", git_branch),
        ):
            if value is not None:
                line[key] = value
        return line

    return _line


@pytest.fixture
def codex_session_meta() -> LineBuilder:
    """Build one Codex ``session_meta`` line."""

    def _line(
        *,
        session_id: str = "01a00000-0000-7000-8000-000000000001",
        cwd: str | None = "/work/api",
        timestamp: str = "2026-08-01T09:00:00.000Z",
    ) -> JsonLine:
        payload: JsonLine = {"id": session_id, "session_id": session_id}
        if cwd is not None:
            payload["cwd"] = cwd
        return {"type": "session_meta", "timestamp": timestamp, "payload": payload}

    return _line


@pytest.fixture
def codex_turn_context() -> LineBuilder:
    """Build one Codex ``turn_context`` line naming the active model."""

    def _line(
        *, model: str = "gpt-5.6-sol", timestamp: str = "2026-08-01T09:00:01.000Z"
    ) -> JsonLine:
        return {"type": "turn_context", "timestamp": timestamp, "payload": {"model": model}}

    return _line


@pytest.fixture
def codex_token_count() -> LineBuilder:
    """Build one Codex token-count ``event_msg`` line."""

    def _line(
        *,
        timestamp: str = "2026-08-01T09:01:00.000Z",
        input_tokens: int = 120,
        cached: int = 100,
        output: int = 30,
        reasoning: int = 12,
        include_info: bool = True,
        used_percent: float | None = 42.5,
        window_minutes: int | None = 10_080,
        resets_at: int | None = 1_787_497_236,
        limit_id: str | None = "codex",
        plan_type: str | None = "team",
        limit_reached: str | None = None,
        spend_control_reached: bool | None = None,
        secondary_used_percent: float | None = None,
    ) -> JsonLine:
        payload: JsonLine = {"type": "token_count", "info": None}
        if include_info:
            payload["info"] = {
                "last_token_usage": {
                    "input_tokens": input_tokens,
                    "cached_input_tokens": cached,
                    "output_tokens": output,
                    "reasoning_output_tokens": reasoning,
                }
            }
        if used_percent is not None:
            payload["rate_limits"] = {
                "limit_id": limit_id,
                "plan_type": plan_type,
                "rate_limit_reached_type": limit_reached,
                "spend_control_reached": spend_control_reached,
                "credits": {"has_credits": True, "unlimited": False, "balance": None},
                "primary": {
                    "used_percent": used_percent,
                    "window_minutes": window_minutes,
                    "resets_at": resets_at,
                },
                "secondary": None
                if secondary_used_percent is None
                else {
                    "used_percent": secondary_used_percent,
                    "window_minutes": 300,
                    "resets_at": resets_at,
                },
            }
        return {"type": "event_msg", "timestamp": timestamp, "payload": payload}

    return _line
