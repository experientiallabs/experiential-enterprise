# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Report usage per local Codex / Claude Code session — metadata only.

``explabs-agent-sessions`` scans the session logs both tools already keep on
this machine and prints one row per session: tokens, models, launch-catalog
attribution cost, time span, and (for Codex) how much of the plan's primary
rate-limit window the session last saw used. Nothing leaves the machine; the
hosted counterpart is the historical-spend import
(``scripts/import_local_ai_spend.py``), which shares this package's parsers.

Usage:
    uv run explabs-agent-sessions                # last 30 days, table
    uv run explabs-agent-sessions --days 0       # full history
    uv run explabs-agent-sessions --json         # machine-readable, unlimited
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path

from explabs.agent_sessions.sessions import (
    AgentSession,
    LimitsReport,
    collect_limits,
    scan_sessions,
)
from explabs.db.stores.gateway_imported_usage_store import ImportSource

# Alignment spec per column: report tables right-align numbers.
_SESSION_HEADERS = (
    ("SOURCE", "<"),
    ("SESSION", "<"),
    ("PROJECT", "<"),
    ("MODELS", "<"),
    ("REQS", ">"),
    ("INPUT", ">"),
    ("CACHED", ">"),
    ("OUTPUT", ">"),
    ("EST COST", ">"),
    ("LAST ACTIVE", "<"),
    ("PLAN USED", "<"),
)
_MODELS_COLUMN_WIDTH = 34


def _compact_tokens(count: int) -> str:
    """Render a token count compactly (1234 -> 1.2k, 2500000 -> 2.5M)."""
    if count >= 1_000_000_000:
        return f"{count / 1_000_000_000:.1f}B"
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}M"
    if count >= 1_000:
        return f"{count / 1_000:.1f}k"
    return str(count)


def _cost_usd(cost_micro_usd: int) -> str:
    """Render integer micro-USD as display dollars."""
    return f"${cost_micro_usd / 1_000_000:.2f}"


def _models_cell(models: tuple[str, ...]) -> str:
    """Join a session's models, truncating long tails to a +N marker."""
    cell = models[0] if models else "-"
    shown = 1
    for model in models[1:]:
        candidate = f"{cell}, {model}"
        if len(candidate) > _MODELS_COLUMN_WIDTH:
            break
        cell = candidate
        shown += 1
    hidden = len(models) - shown
    return f"{cell} +{hidden}" if hidden > 0 else cell


def _window_span(window_minutes: int | None) -> str:
    """Render a rate-limit window's length (10080 -> 7d, 300 -> 5h)."""
    if window_minutes is None:
        return "-"
    if window_minutes % 1_440 == 0:
        return f"{window_minutes // 1_440}d"
    return f"{window_minutes / 60:.0f}h"


def _plan_cell(session: AgentSession) -> str:
    """Render the Codex plan window as 'used% of window'."""
    window = session.plan_window
    if window is None or window.used_percent is None:
        return "-"
    if window.window_minutes is None:
        return f"{window.used_percent:.0f}%"
    return f"{window.used_percent:.0f}% of {_window_span(window.window_minutes)}"


def _row(session: AgentSession) -> tuple[str, ...]:
    """Project one session into its table row."""
    project = Path(session.project_dir).name if session.project_dir else "-"
    return (
        session.source.value,
        session.session_id[:8],
        project,
        _models_cell(session.models),
        str(session.request_count),
        _compact_tokens(session.input_tokens),
        _compact_tokens(session.cached_tokens),
        _compact_tokens(session.output_tokens),
        _cost_usd(session.estimated_cost_micro_usd),
        session.ended_at.strftime("%Y-%m-%d %H:%M"),
        _plan_cell(session),
    )


def _render_table(headers: Sequence[tuple[str, str]], rows: Sequence[tuple[str, ...]]) -> str:
    """Render header + rows with per-column alignment."""
    titles = tuple(title for title, _ in headers)
    widths = [
        max(len(titles[column]), *(len(row[column]) for row in rows))
        if rows
        else len(titles[column])
        for column in range(len(titles))
    ]

    def line(cells: tuple[str, ...]) -> str:
        return "  ".join(
            f"{cell:{align}{width}}"
            for cell, (_, align), width in zip(cells, headers, widths, strict=True)
        ).rstrip()

    divider = "  ".join("-" * width for width in widths)
    return "\n".join([line(titles), divider, *(line(row) for row in rows)])


_LIMIT_HEADERS = (
    ("LIMIT", "<"),
    ("PLAN", "<"),
    ("WINDOW", "<"),
    ("USED", ">"),
    ("RESETS", "<"),
    ("CREDITS", "<"),
    ("REACHED", "<"),
)
_FAILURE_HEADERS = (("KIND", "<"), ("COUNT", ">"), ("LAST SEEN", "<"))


def _render_limits(report: LimitsReport) -> str:
    """Render the credential-limit report: plan windows, then failures."""
    sections: list[str] = ["CODEX PLAN LIMITS"]
    limit_rows: list[tuple[str, ...]] = []
    for status in report.codex:
        reached = status.limit_reached or ("spend-control" if status.spend_control_reached else "-")
        credit_cell = "-" if status.has_credits is None else ("yes" if status.has_credits else "no")
        for window in (status.primary, status.secondary):
            if window is None:
                continue
            used = "-" if window.used_percent is None else f"{window.used_percent:.0f}%"
            resets = (
                "-" if window.resets_at is None else window.resets_at.strftime("%Y-%m-%d %H:%M")
            )
            limit_rows.append(
                (
                    status.limit_id or "-",
                    status.plan_type or "-",
                    _window_span(window.window_minutes),
                    used,
                    resets,
                    credit_cell,
                    reached,
                )
            )
    if limit_rows:
        sections.append(_render_table(_LIMIT_HEADERS, limit_rows))
    else:
        sections.append("no plan-limit observations in the scanned window")
    sections.append("")
    sections.append("CLAUDE CODE API FAILURES")
    if report.claude_api_errors:
        failure_rows = [
            (
                status.kind,
                str(status.count),
                status.last_seen.strftime("%Y-%m-%d %H:%M"),
            )
            for status in report.claude_api_errors
        ]
        sections.append(_render_table(_FAILURE_HEADERS, failure_rows))
    else:
        sections.append("no API failures in the scanned window")
    return "\n".join(sections)


def _totals(sessions: Sequence[AgentSession]) -> str:
    """Summarize per-source totals across every reported session."""
    lines: list[str] = []
    for source in ImportSource:
        matching = [session for session in sessions if session.source == source]
        if not matching:
            continue
        requests = sum(session.request_count for session in matching)
        output = sum(session.output_tokens for session in matching)
        fresh = sum(session.input_tokens for session in matching)
        cached = sum(session.cached_tokens for session in matching)
        cost = sum(session.estimated_cost_micro_usd for session in matching)
        lines.append(
            f"{source.value}: {len(matching)} sessions, {requests} requests, "
            f"{_compact_tokens(fresh)} input + {_compact_tokens(cached)} cached, "
            f"{_compact_tokens(output)} output, {_cost_usd(cost)} attributed"
        )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    """Scan local session logs and print the per-session usage report."""
    parser = argparse.ArgumentParser(
        description="Report usage per local Codex / Claude Code session (metadata only)."
    )
    parser.add_argument("--claude-dir", default=str(Path.home() / ".claude" / "projects"))
    parser.add_argument("--codex-dir", default=str(Path.home() / ".codex" / "sessions"))
    parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="only read log files modified in the last N days; 0 reads all history",
    )
    parser.add_argument(
        "--source",
        choices=[source.value for source in ImportSource],
        default=None,
        help="limit the report to one tool",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=25,
        help="table rows shown (most recent first); 0 shows every session",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print every session as JSON instead of the table (never limited)",
    )
    parser.add_argument(
        "--limits",
        action="store_true",
        help=(
            "report credential limit state instead of sessions: Codex plan windows "
            "(used %%, resets, reached) and Claude Code API-failure counts; "
            "honors --days and --json, ignores --source/--limit"
        ),
    )
    args = parser.parse_args(argv)

    modified_since = None if args.days == 0 else datetime.now(tz=UTC) - timedelta(days=args.days)
    if args.limits:
        report = collect_limits(
            claude_root=Path(args.claude_dir),
            codex_root=Path(args.codex_dir),
            modified_since=modified_since,
        )
        if args.json:
            print(json.dumps(report.model_dump(mode="json"), indent=2))
        else:
            print(_render_limits(report))
        return 0
    sessions = scan_sessions(
        claude_root=Path(args.claude_dir),
        codex_root=Path(args.codex_dir),
        modified_since=modified_since,
    )
    if args.source is not None:
        sessions = [session for session in sessions if session.source.value == args.source]

    if args.json:
        print(json.dumps([session.model_dump(mode="json") for session in sessions], indent=2))
        return 0
    if not sessions:
        print("No local coding-agent sessions found.")
        return 0

    shown = sessions if args.limit == 0 else sessions[: args.limit]
    print(_render_table(_SESSION_HEADERS, [_row(session) for session in shown]))
    if len(shown) < len(sessions):
        print(f"\n({len(sessions) - len(shown)} older sessions hidden; --limit 0 shows all)")
    print(f"\n{_totals(sessions)}")
    return 0


if __name__ == "__main__":  # pragma: no cover - console script owns this path
    raise SystemExit(main())
