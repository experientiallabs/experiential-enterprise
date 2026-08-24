# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for per-session aggregation of scanned coding-agent logs."""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

from explabs.agent_sessions.records import (
    CodexLimitObservation,
    SessionFileScan,
    TurnUsage,
    WindowState,
)
from explabs.agent_sessions.sessions import build_sessions, collect_limits, scan_sessions
from explabs.db.stores.gateway_imported_usage_store import ImportSource
from explabs.usage_import_catalog import price_usage

type JsonLine = dict[str, object]


def _turn(
    *,
    event_id: str,
    model: str = "claude-fable-5",
    timestamp: str = "2026-08-01T10:00:00.000Z",
    input_tokens: int = 10,
    cached_tokens: int = 5,
    output_tokens: int = 20,
    reasoning_tokens: int = 3,
) -> TurnUsage:
    return TurnUsage(
        source=ImportSource.CLAUDE_CODE,
        event_id=event_id,
        model=model,
        input_tokens=input_tokens,
        cached_tokens=cached_tokens,
        output_tokens=output_tokens,
        reasoning_tokens=reasoning_tokens,
        timestamp=timestamp,
    )


def _scan(
    turns: tuple[TurnUsage, ...],
    *,
    source: ImportSource = ImportSource.CLAUDE_CODE,
    session_id: str = "sess-1",
    file_stem: str = "file-1",
    project_dir: str | None = "/work/demo",
    git_branch: str | None = "main",
    limit_observation: CodexLimitObservation | None = None,
) -> SessionFileScan:
    return SessionFileScan(
        source=source,
        session_id=session_id,
        file_stem=file_stem,
        project_dir=project_dir,
        git_branch=git_branch,
        turns=turns,
        limit_observation=limit_observation,
        api_errors=(),
    )


def _observation(*, used_percent: float, observed_at: str) -> CodexLimitObservation:
    return CodexLimitObservation(
        limit_id="codex",
        plan_type="team",
        primary=WindowState(
            used_percent=used_percent, window_minutes=10_080, resets_at_epoch=1_787_497_236
        ),
        secondary=None,
        has_credits=True,
        limit_reached=None,
        spend_control_reached=None,
        observed_at=observed_at,
    )


def test_build_sessions_folds_dedupes_and_spans() -> None:
    """One session folds across files with dedupe, time span, and metadata."""
    early = _turn(event_id="a", timestamp="2026-08-01T10:00:00.000Z")
    late = _turn(event_id="b", model="claude-opus-5", timestamp="2026-08-01T11:30:00.000Z")
    duplicate = _turn(event_id="a", timestamp="2026-08-01T10:00:00.000Z")

    (session,) = build_sessions(
        [
            _scan((early,), project_dir=None, git_branch=None),
            _scan((late, duplicate)),
        ]
    )

    assert session.session_id == "sess-1"
    assert session.request_count == 2
    assert session.models == ("claude-fable-5", "claude-opus-5")
    assert session.input_tokens == 20
    assert session.cached_tokens == 10
    assert session.output_tokens == 40
    assert session.reasoning_tokens == 6
    assert session.started_at == datetime(2026, 8, 1, 10, 0, tzinfo=UTC)
    assert session.ended_at == datetime(2026, 8, 1, 11, 30, tzinfo=UTC)
    # Workspace metadata comes from the first scan that carries it.
    assert session.project_dir == "/work/demo"
    assert session.git_branch == "main"


def test_build_sessions_prices_per_turn_from_the_catalog() -> None:
    """Catalog models price per turn; unmatched models attribute zero."""
    priced = _turn(event_id="a")
    unmatched = _turn(event_id="b", model="totally-unknown-model")

    (session,) = build_sessions([_scan((priced, unmatched))])

    expected = price_usage(
        priced.model,
        input_tokens=priced.input_tokens,
        cached_input_tokens=priced.cached_tokens,
        output_tokens=priced.output_tokens,
    ).cost_micro_usd
    assert expected > 0
    assert session.estimated_cost_micro_usd == expected


def test_build_sessions_drops_undated_turns_and_usage_free_sessions() -> None:
    """Undated turns and usage-free scans produce no sessions."""
    undated = _turn(event_id="a", timestamp="not-a-time")

    assert build_sessions([_scan((undated,)), _scan((), session_id="empty")]) == []


def test_build_sessions_latest_plan_window_wins() -> None:
    """The most recently observed plan window represents the session."""
    stale = _observation(used_percent=10.0, observed_at="2026-08-01T09:00:00.000Z")
    fresh = _observation(used_percent=80.0, observed_at="2026-08-01T12:00:00.000Z")

    (session,) = build_sessions(
        [
            _scan((_turn(event_id="a"),), limit_observation=fresh),
            _scan((_turn(event_id="b"),), limit_observation=stale),
        ]
    )

    assert session.plan_window is not None
    assert session.plan_window.used_percent == 80.0
    assert session.plan_window.resets_at == datetime.fromtimestamp(1_787_497_236, tz=UTC)


def test_scan_sessions_reads_both_stores_most_recent_first(
    claude_root: Path,
    codex_root: Path,
    write_claude_session: Callable[..., Path],
    write_codex_session: Callable[..., Path],
    claude_assistant_line: Callable[..., JsonLine],
    codex_session_meta: Callable[..., JsonLine],
    codex_turn_context: Callable[..., JsonLine],
    codex_token_count: Callable[..., JsonLine],
) -> None:
    """Both stores scan into one list ordered by last activity."""
    write_claude_session("s1", [claude_assistant_line(timestamp="2026-08-01T10:00:00.000Z")])
    write_codex_session(
        "rollout-x",
        [
            codex_session_meta(),
            codex_turn_context(),
            codex_token_count(timestamp="2026-08-02T10:00:00.000Z"),
        ],
    )

    sessions = scan_sessions(claude_root=claude_root, codex_root=codex_root)

    assert [session.source for session in sessions] == [
        ImportSource.CODEX,
        ImportSource.CLAUDE_CODE,
    ]


def test_scan_sessions_window_filters_on_file_mtime(
    claude_root: Path,
    codex_root: Path,
    write_claude_session: Callable[..., Path],
    claude_assistant_line: Callable[..., JsonLine],
) -> None:
    """The modified-since window drops files older than the cutoff."""
    write_claude_session("fresh", [claude_assistant_line()])
    stale_path = write_claude_session(
        "stale", [claude_assistant_line(session_id="99999999-2222-4333-8444-555555555555")]
    )
    ninety_days = 90 * 24 * 3600
    os.utime(stale_path, (time.time() - ninety_days, time.time() - ninety_days))

    sessions = scan_sessions(
        claude_root=claude_root,
        codex_root=codex_root,
        modified_since=datetime.now(tz=UTC) - timedelta(days=30),
    )

    assert [session.session_id for session in sessions] == ["11111111-2222-4333-8444-555555555555"]


def test_forked_session_history_attributes_to_the_original() -> None:
    """Copied fork history counts once, under the session that made the calls."""
    a = _turn(event_id="a", timestamp="2026-08-01T10:00:00.000Z")
    b = _turn(event_id="b", timestamp="2026-08-01T10:05:00.000Z")
    c = _turn(event_id="c", timestamp="2026-08-01T11:00:00.000Z")

    sessions = build_sessions(
        [
            _scan((a, b), session_id="original"),
            _scan((a, b, c), session_id="fork"),
        ]
    )

    by_id = {session.session_id: session for session in sessions}
    assert by_id["original"].request_count == 2
    assert by_id["fork"].request_count == 1
    assert by_id["fork"].started_at == datetime(2026, 8, 1, 11, 0, tzinfo=UTC)


def test_codex_sibling_threads_never_collapse_on_ordinal_ids() -> None:
    """Codex sibling threads sharing a session id keep every real turn."""

    # Two rollout files (a main thread and an auto-review thread) can carry
    # the same session id, each minting ordinal event ids from zero. The
    # colliding ids are DIFFERENT real API calls and must all count.
    def codex_turn(model: str, timestamp: str, output_tokens: int) -> TurnUsage:
        return TurnUsage(
            source=ImportSource.CODEX,
            event_id="sess-c:0",
            model=model,
            input_tokens=10,
            cached_tokens=0,
            output_tokens=output_tokens,
            reasoning_tokens=0,
            timestamp=timestamp,
        )

    (session,) = build_sessions(
        [
            _scan(
                (codex_turn("gpt-5.6-sol", "2026-08-01T10:00:00.000Z", 100),),
                source=ImportSource.CODEX,
                session_id="sess-c",
                file_stem="rollout-main",
            ),
            _scan(
                (codex_turn("codex-auto-review", "2026-08-01T10:05:00.000Z", 40),),
                source=ImportSource.CODEX,
                session_id="sess-c",
                file_stem="rollout-review",
            ),
        ]
    )

    assert session.request_count == 2
    assert session.output_tokens == 140
    assert session.models == ("gpt-5.6-sol", "codex-auto-review")


def test_collect_limits_reads_latest_state_and_failures(
    claude_root: Path,
    codex_root: Path,
    write_claude_session: Callable[..., Path],
    write_codex_session: Callable[..., Path],
    claude_assistant_line: Callable[..., JsonLine],
    codex_session_meta: Callable[..., JsonLine],
    codex_turn_context: Callable[..., JsonLine],
    codex_token_count: Callable[..., JsonLine],
) -> None:
    """The newest Codex observation per limit id wins; failures aggregate."""
    write_codex_session(
        "rollout-old",
        [
            codex_session_meta(),
            codex_turn_context(),
            codex_token_count(timestamp="2026-08-01T09:00:00.000Z", used_percent=40.0),
        ],
    )
    write_codex_session(
        "rollout-new",
        [
            codex_session_meta(session_id="01a00000-0000-7000-8000-000000000002"),
            codex_turn_context(),
            codex_token_count(
                timestamp="2026-08-02T09:00:00.000Z",
                used_percent=100.0,
                secondary_used_percent=61.5,
                limit_reached="weekly",
            ),
        ],
    )
    write_claude_session(
        "s1",
        [
            claude_assistant_line(),
            claude_assistant_line(
                message_id="msg_err",
                api_error="rate_limit",
                timestamp="2026-08-02T10:00:00.000Z",
            ),
        ],
    )

    report = collect_limits(claude_root=claude_root, codex_root=codex_root)

    (codex,) = report.codex
    assert codex.limit_id == "codex"
    assert codex.plan_type == "team"
    assert codex.limit_reached == "weekly"
    assert codex.primary is not None
    assert codex.primary.used_percent == 100.0
    assert codex.secondary is not None
    assert codex.secondary.used_percent == 61.5
    assert codex.observed_at == datetime(2026, 8, 2, 9, 0, tzinfo=UTC)
    (failure,) = report.claude_api_errors
    assert failure.kind == "rate_limit"
    assert failure.count == 1
    assert failure.last_seen == datetime(2026, 8, 2, 10, 0, tzinfo=UTC)
