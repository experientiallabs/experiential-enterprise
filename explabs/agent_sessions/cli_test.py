# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the local per-session usage report CLI."""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from explabs.agent_sessions.cli import main

type JsonLine = dict[str, object]


@pytest.fixture
def populated_roots(
    claude_root: Path,
    codex_root: Path,
    write_claude_session: Callable[..., Path],
    write_codex_session: Callable[..., Path],
    claude_assistant_line: Callable[..., JsonLine],
    codex_session_meta: Callable[..., JsonLine],
    codex_turn_context: Callable[..., JsonLine],
    codex_token_count: Callable[..., JsonLine],
) -> tuple[Path, Path]:
    """One Claude Code session and one Codex session with real-shaped usage."""
    write_claude_session("s1", [claude_assistant_line()])
    write_codex_session(
        "rollout-x",
        [
            codex_session_meta(),
            codex_turn_context(),
            codex_token_count(timestamp="2026-08-02T10:00:00.000Z", used_percent=87.5),
        ],
    )
    return claude_root, codex_root


def _run(args: list[str]) -> int:
    return main(args)


def test_json_reports_both_sources(
    populated_roots: tuple[Path, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    """--json emits one entry per session with normalized fields."""
    claude_root, codex_root = populated_roots

    exit_code = _run(["--claude-dir", str(claude_root), "--codex-dir", str(codex_root), "--json"])

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    by_source = {entry["source"]: entry for entry in payload}
    assert set(by_source) == {"claude-code", "codex"}
    claude = by_source["claude-code"]
    assert claude["request_count"] == 1
    assert claude["input_tokens"] == 32
    assert claude["git_branch"] == "main"
    codex = by_source["codex"]
    assert codex["plan_window"]["used_percent"] == 87.5
    assert codex["models"] == ["gpt-5.6-sol"]


def test_table_lists_sessions_and_totals(
    populated_roots: tuple[Path, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    """The table shows sessions, the plan window, and per-source totals."""
    claude_root, codex_root = populated_roots

    exit_code = _run(["--claude-dir", str(claude_root), "--codex-dir", str(codex_root)])

    assert exit_code == 0
    out = capsys.readouterr().out
    assert "SOURCE" in out
    assert "PLAN USED" in out
    assert "11111111" in out
    assert "88% of 7d" in out
    assert "claude-code: 1 sessions" in out
    assert "codex: 1 sessions" in out


def test_source_filter_limits_the_report(
    populated_roots: tuple[Path, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    """--source restricts the report to one tool."""
    claude_root, codex_root = populated_roots

    exit_code = _run(
        [
            "--claude-dir",
            str(claude_root),
            "--codex-dir",
            str(codex_root),
            "--source",
            "codex",
            "--json",
        ]
    )

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert [entry["source"] for entry in payload] == ["codex"]


def test_limit_notes_hidden_sessions(
    claude_root: Path,
    codex_root: Path,
    write_claude_session: Callable[..., Path],
    claude_assistant_line: Callable[..., JsonLine],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """--limit hides older rows loudly; totals still cover everything."""
    write_claude_session("s1", [claude_assistant_line()])
    write_claude_session(
        "s2",
        [
            claude_assistant_line(
                message_id="msg_101",
                session_id="22222222-2222-4333-8444-555555555555",
                timestamp="2026-08-02T10:00:00.000Z",
            )
        ],
    )

    exit_code = _run(
        [
            "--claude-dir",
            str(claude_root),
            "--codex-dir",
            str(codex_root),
            "--limit",
            "1",
        ]
    )

    assert exit_code == 0
    out = capsys.readouterr().out
    assert "(1 older sessions hidden; --limit 0 shows all)" in out
    # Totals still cover every session, not just the visible rows.
    assert "claude-code: 2 sessions" in out


def test_days_window_excludes_stale_files(
    claude_root: Path,
    codex_root: Path,
    write_claude_session: Callable[..., Path],
    claude_assistant_line: Callable[..., JsonLine],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """--days windows the scan by file mtime; --days 0 reads everything."""
    stale_path = write_claude_session("stale", [claude_assistant_line()])
    ninety_days = 90 * 24 * 3600
    os.utime(stale_path, (time.time() - ninety_days, time.time() - ninety_days))

    assert _run(["--claude-dir", str(claude_root), "--codex-dir", str(codex_root)]) == 0
    assert "No local coding-agent sessions found." in capsys.readouterr().out

    assert (
        _run(["--claude-dir", str(claude_root), "--codex-dir", str(codex_root), "--days", "0"]) == 0
    )
    assert "11111111" in capsys.readouterr().out


def test_missing_roots_report_cleanly(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """Absent log directories report cleanly with exit code 0."""
    missing = tmp_path / "nope"

    exit_code = _run(["--claude-dir", str(missing), "--codex-dir", str(missing)])

    assert exit_code == 0
    assert "No local coding-agent sessions found." in capsys.readouterr().out


def test_limits_report_table_and_json(
    populated_roots: tuple[Path, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    """--limits reports plan windows and failure counts, honoring --json."""
    claude_root, codex_root = populated_roots

    exit_code = _run(["--claude-dir", str(claude_root), "--codex-dir", str(codex_root), "--limits"])

    assert exit_code == 0
    out = capsys.readouterr().out
    assert "CODEX PLAN LIMITS" in out
    assert "codex" in out
    assert "team" in out
    assert "88%" in out
    assert "CLAUDE CODE API FAILURES" in out
    assert "no API failures in the scanned window" in out

    exit_code = _run(
        [
            "--claude-dir",
            str(claude_root),
            "--codex-dir",
            str(codex_root),
            "--limits",
            "--json",
        ]
    )

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    (codex,) = payload["codex"]
    assert codex["limit_id"] == "codex"
    assert codex["primary"]["used_percent"] == 87.5
    assert payload["claude_api_errors"] == []
