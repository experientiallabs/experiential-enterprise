# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the typed Codex / Claude Code session-log parsers."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from explabs.agent_sessions.records import (
    collect_turns,
    scan_claude_file,
    scan_codex_file,
)
from explabs.db.stores.gateway_imported_usage_store import ImportSource

type JsonLine = dict[str, object]


def test_claude_scan_normalizes_tokens_and_metadata(
    write_claude_session: Callable[..., Path],
    claude_assistant_line: Callable[..., JsonLine],
) -> None:
    """Fresh input adds cache writes; identity and workspace come from the line."""
    path = write_claude_session("s1", [claude_assistant_line()])

    scan = scan_claude_file(path)

    assert scan.source is ImportSource.CLAUDE_CODE
    assert scan.session_id == "11111111-2222-4333-8444-555555555555"
    assert scan.project_dir == "/work/demo"
    assert scan.git_branch == "main"
    assert scan.limit_observation is None
    assert scan.api_errors == ()
    (turn,) = scan.turns
    # Claude counts cache writes outside input_tokens: fresh = input + cache_write.
    assert turn.input_tokens == 2 + 30
    assert turn.cached_tokens == 100
    assert turn.output_tokens == 40
    assert turn.reasoning_tokens == 7
    assert turn.event_id == "msg_001"
    assert turn.model == "claude-fable-5"
    assert turn.timestamp == "2026-08-01T10:00:00.000Z"


def test_claude_scan_dedupes_streamed_chunks_last_wins(
    write_claude_session: Callable[..., Path],
    claude_assistant_line: Callable[..., JsonLine],
) -> None:
    """Streamed chunks sharing a message id count once, final usage winning."""
    # Streaming appends the same API response as several lines that share a
    # message id, with usage GROWING across chunks; the last line carries the
    # response's final counts.
    path = write_claude_session(
        "s1",
        [
            claude_assistant_line(line_uuid="uuid-a", output_tokens=3, thinking=0),
            claude_assistant_line(line_uuid="uuid-b", output_tokens=40, thinking=7),
            claude_assistant_line(message_id="msg_002", line_uuid="uuid-c"),
        ],
    )

    scan = scan_claude_file(path)

    assert [turn.event_id for turn in scan.turns] == ["msg_001", "msg_002"]
    assert scan.turns[0].output_tokens == 40
    assert scan.turns[0].reasoning_tokens == 7


def test_claude_scan_skips_non_usage_lines(
    write_claude_session: Callable[..., Path],
    claude_assistant_line: Callable[..., JsonLine],
) -> None:
    """Decoys, malformed JSON, zero usage, and undated lines yield no turns."""
    decoy = {
        "type": "user",
        # Content that merely mentions the assistant marker must not parse as
        # usage: the pre-filter passes, the typed check rejects.
        "message": {"content": 'the transcript said "type":"assistant" earlier'},
    }
    zero_usage = claude_assistant_line(
        message_id="msg_zero", input_tokens=0, output_tokens=0, cache_read=0, cache_write=0
    )
    no_model = claude_assistant_line(message_id="msg_nm", model=None)
    undated = claude_assistant_line(message_id="msg_nd", timestamp=None)
    path = write_claude_session("s1", [decoy, zero_usage, no_model, undated])
    raw = path.read_text(encoding="utf-8")
    path.write_text(f"not json {{\n{raw}", encoding="utf-8")

    scan = scan_claude_file(path)

    assert scan.turns == ()


def test_claude_scan_identity_fallbacks(
    write_claude_session: Callable[..., Path],
    claude_assistant_line: Callable[..., JsonLine],
) -> None:
    """Event ids fall back from message id to line uuid to file:line."""
    # No message id -> the line uuid; neither -> file name + raw line index.
    path = write_claude_session(
        "anon",
        [
            claude_assistant_line(message_id=None, session_id=None),
            claude_assistant_line(message_id=None, line_uuid=None, session_id=None),
        ],
    )

    scan = scan_claude_file(path)

    assert scan.session_id == "anon"
    assert [turn.event_id for turn in scan.turns] == ["uuid-001", "anon.jsonl:1"]


def test_codex_scan_state_machine(
    write_codex_session: Callable[..., Path],
    codex_session_meta: Callable[..., JsonLine],
    codex_turn_context: Callable[..., JsonLine],
    codex_token_count: Callable[..., JsonLine],
) -> None:
    """Model tracking, cached-inclusive input, ordinal ids, and the plan window."""
    path = write_codex_session(
        "rollout-2026-08-01T09-00-00-01a00000-0000-7000-8000-000000000001",
        [
            codex_session_meta(),
            codex_turn_context(model="gpt-5.6-sol"),
            codex_token_count(timestamp="2026-08-01T09:01:00.000Z", used_percent=10.0),
            codex_turn_context(model="gpt-5.2-codex"),
            codex_token_count(
                timestamp="2026-08-01T09:05:00.000Z",
                input_tokens=500,
                cached=200,
                output=80,
                reasoning=20,
                used_percent=55.0,
            ),
        ],
    )

    scan = scan_codex_file(path)

    assert scan.source is ImportSource.CODEX
    assert scan.session_id == "01a00000-0000-7000-8000-000000000001"
    assert scan.project_dir == "/work/api"
    assert scan.git_branch is None
    first, second = scan.turns
    # Codex counts cached reads inside input_tokens: fresh = input - cached.
    assert first.input_tokens == 120 - 100
    assert first.cached_tokens == 100
    assert first.model == "gpt-5.6-sol"
    assert second.input_tokens == 500 - 200
    assert second.model == "gpt-5.2-codex"
    assert second.reasoning_tokens == 20
    # Ordinal event ids scoped to the session id, in emission order.
    assert [turn.event_id for turn in scan.turns] == [
        "01a00000-0000-7000-8000-000000000001:0",
        "01a00000-0000-7000-8000-000000000001:1",
    ]
    observation = scan.limit_observation
    assert observation is not None
    assert observation.limit_id == "codex"
    assert observation.plan_type == "team"
    assert observation.limit_reached is None
    assert observation.primary is not None
    assert observation.primary.used_percent == 55.0
    assert observation.primary.window_minutes == 10_080
    assert observation.observed_at == "2026-08-01T09:05:00.000Z"


def test_codex_scan_tolerates_missing_model_and_null_info(
    write_codex_session: Callable[..., Path],
    codex_token_count: Callable[..., JsonLine],
    codex_turn_context: Callable[..., JsonLine],
) -> None:
    """Model-less and info-less events drop, but the plan window still lands."""
    # A token event before any turn_context has no model; a null info block
    # has no usage. Neither yields a turn, but the plan window still lands,
    # and without session_meta the session id falls back to the file stem.
    path = write_codex_session(
        "rollout-orphan",
        [
            codex_token_count(used_percent=99.5),
            codex_turn_context(),
            codex_token_count(include_info=False, used_percent=100.0),
        ],
    )

    scan = scan_codex_file(path)

    assert scan.session_id == "rollout-orphan"
    assert scan.turns == ()
    assert scan.limit_observation is not None
    assert scan.limit_observation.primary is not None
    assert scan.limit_observation.primary.used_percent == 100.0


def test_collect_turns_merges_both_roots_and_skips_absent(
    tmp_path: Path,
    claude_root: Path,
    codex_root: Path,
    write_claude_session: Callable[..., Path],
    write_codex_session: Callable[..., Path],
    claude_assistant_line: Callable[..., JsonLine],
    codex_session_meta: Callable[..., JsonLine],
    codex_turn_context: Callable[..., JsonLine],
    codex_token_count: Callable[..., JsonLine],
) -> None:
    """Both stores contribute turns; missing roots read as empty."""
    write_claude_session("s1", [claude_assistant_line()])
    write_codex_session(
        "rollout-x", [codex_session_meta(), codex_turn_context(), codex_token_count()]
    )

    turns = collect_turns(claude_root, codex_root)
    assert {turn.source for turn in turns} == {ImportSource.CLAUDE_CODE, ImportSource.CODEX}

    missing = tmp_path / "does-not-exist"
    assert collect_turns(missing, missing) == []


def test_claude_scan_captures_api_error_kinds(
    write_claude_session: Callable[..., Path],
    claude_assistant_line: Callable[..., JsonLine],
) -> None:
    """Failed API calls record their error kind and timestamp, never text."""
    failed = claude_assistant_line(
        message_id="msg_err",
        model="<synthetic>",
        api_error="rate_limit",
        input_tokens=0,
        output_tokens=0,
        cache_read=0,
        cache_write=0,
        thinking=0,
        timestamp="2026-08-01T12:00:00.000Z",
    )
    path = write_claude_session("s1", [claude_assistant_line(), failed])

    scan = scan_claude_file(path)

    # The failed call carries no usage, so it is an error event, not a turn.
    assert [turn.event_id for turn in scan.turns] == ["msg_001"]
    (event,) = scan.api_errors
    assert event.kind == "rate_limit"
    assert event.timestamp == "2026-08-01T12:00:00.000Z"
