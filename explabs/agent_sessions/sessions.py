# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Aggregate scanned session logs into per-session usage summaries.

Where ``records`` reads one log file into per-turn usage, this module folds
those scans into one ``AgentSession`` per (source, session id): total tokens,
the models used, the session's time span, an attribution cost from the launch
catalog list price, and — for Codex — the plan rate-limit window the session
last observed. Cost follows the same conservative catalog mapping as the
hosted import lane (``explabs.usage_import_catalog``): an unmatched model
reports zero rather than a guessed price.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import assert_never

from pydantic import BaseModel, ConfigDict, Field

from explabs.agent_sessions.records import (
    SessionFileScan,
    TurnUsage,
    WindowState,
    scan_claude_file,
    scan_codex_file,
)
from explabs.db.stores.gateway_imported_usage_store import ImportSource
from explabs.usage_import_catalog import price_usage


class PlanWindow(BaseModel):
    """Codex plan rate-limit state at the session's last observed API call."""

    model_config = ConfigDict(frozen=True)

    used_percent: float | None
    window_minutes: int | None
    resets_at: datetime | None
    observed_at: datetime


class AgentSession(BaseModel):
    """Per-session usage rollup for one local coding-agent session.

    Metadata only: identifiers, workspace paths, models, token counts, and
    times — never any message content. ``estimated_cost_micro_usd`` is the
    launch-catalog attribution (zero for models outside the catalog), the
    same convention as the hosted historical-spend import.
    """

    model_config = ConfigDict(frozen=True)

    source: ImportSource
    session_id: str
    project_dir: str | None
    git_branch: str | None
    models: tuple[str, ...]
    request_count: int = Field(ge=0)
    input_tokens: int = Field(ge=0)
    cached_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    reasoning_tokens: int = Field(ge=0)
    estimated_cost_micro_usd: int = Field(ge=0)
    started_at: datetime
    ended_at: datetime
    plan_window: PlanWindow | None


def _parse_timestamp(value: str) -> datetime | None:
    """Parse a log timestamp to aware UTC; None when unparseable."""
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _resets_at(state: WindowState | None) -> datetime | None:
    """Convert a window's epoch reset instant, or None when absent."""
    if state is None or state.resets_at_epoch is None:
        return None
    return datetime.fromtimestamp(state.resets_at_epoch, tz=UTC)


def _plan_window_view(scans: Sequence[SessionFileScan]) -> PlanWindow | None:
    """Project the latest primary-window observation across a session's scans."""
    latest: tuple[datetime, PlanWindow] | None = None
    for scan in scans:
        observation = scan.limit_observation
        if observation is None or observation.primary is None:
            continue
        observed_at = _parse_timestamp(observation.observed_at)
        if observed_at is None:
            continue
        view = PlanWindow(
            used_percent=observation.primary.used_percent,
            window_minutes=observation.primary.window_minutes,
            resets_at=_resets_at(observation.primary),
            observed_at=observed_at,
        )
        if latest is None or observed_at > latest[0]:
            latest = (observed_at, view)
    return latest[1] if latest is not None else None


def _turn_key(scan: SessionFileScan, turn: TurnUsage) -> tuple[str, str, str]:
    """A turn's identity for copied-history dedupe across log files.

    Claude Code message ids are server-issued and globally unique, so the
    same id in two files is a fork-copied response — one identity. Codex
    ordinal ids are only unique within one rollout file (sibling threads
    reuse a session id with their own counters), so Codex turns are scoped
    by file and never collapse across files.
    """
    match scan.source:
        case ImportSource.CLAUDE_CODE:
            return (scan.source.value, "", turn.event_id)
        case ImportSource.CODEX:
            return (scan.source.value, scan.file_stem, turn.event_id)
    assert_never(scan.source)


def _dated_turns(
    scans: Sequence[SessionFileScan],
) -> dict[tuple[str, str, str], tuple[datetime, TurnUsage]]:
    """Collect one session's turns by identity, dropping undated ones."""
    dated: dict[tuple[str, str, str], tuple[datetime, TurnUsage]] = {}
    for scan in scans:
        for turn in scan.turns:
            key = _turn_key(scan, turn)
            if key in dated:
                continue
            occurred_at = _parse_timestamp(turn.timestamp)
            if occurred_at is not None:
                dated[key] = (occurred_at, turn)
    return dated


def _fold(
    scans: Sequence[SessionFileScan], owned: list[tuple[datetime, TurnUsage]]
) -> AgentSession:
    """Fold one session's owned turns into a rollup."""
    dated = sorted(owned, key=lambda item: item[0])
    models: list[str] = []
    input_tokens = cached_tokens = output_tokens = reasoning_tokens = cost_micro = 0
    for _, turn in dated:
        if turn.model not in models:
            models.append(turn.model)
        input_tokens += turn.input_tokens
        cached_tokens += turn.cached_tokens
        output_tokens += turn.output_tokens
        reasoning_tokens += turn.reasoning_tokens
        cost_micro += price_usage(
            turn.model,
            input_tokens=turn.input_tokens,
            cached_input_tokens=turn.cached_tokens,
            output_tokens=turn.output_tokens,
        ).cost_micro_usd
    first = scans[0]
    project_dir = next((scan.project_dir for scan in scans if scan.project_dir), None)
    git_branch = next((scan.git_branch for scan in scans if scan.git_branch), None)
    return AgentSession(
        source=first.source,
        session_id=first.session_id,
        project_dir=project_dir,
        git_branch=git_branch,
        models=tuple(models),
        request_count=len(dated),
        input_tokens=input_tokens,
        cached_tokens=cached_tokens,
        output_tokens=output_tokens,
        reasoning_tokens=reasoning_tokens,
        estimated_cost_micro_usd=cost_micro,
        started_at=dated[0][0],
        ended_at=dated[-1][0],
        plan_window=_plan_window_view(scans),
    )


def build_sessions(scans: Iterable[SessionFileScan]) -> list[AgentSession]:
    """Fold file scans into sessions, most recently active first.

    Forking a Claude Code session copies its transcript into a new log file
    with the original message ids intact, so a turn can appear under several
    session ids. Each turn is attributed to the earliest-starting (on a tie,
    smallest) session that contains it — the one that actually made the API
    call — so copied history never double-counts across sessions, matching
    the hosted import lane's hash dedupe. Codex turns are file-scoped (see
    ``_turn_key``) and are all genuine, so nothing collapses there.
    """
    grouped: dict[tuple[ImportSource, str], list[SessionFileScan]] = {}
    for scan in scans:
        if not scan.turns:
            continue
        grouped.setdefault((scan.source, scan.session_id), []).append(scan)
    prepared: list[
        tuple[
            datetime,
            int,
            list[SessionFileScan],
            dict[tuple[str, str, str], tuple[datetime, TurnUsage]],
        ]
    ] = []
    for group in grouped.values():
        dated = _dated_turns(group)
        if not dated:
            continue
        earliest = min(occurred_at for occurred_at, _ in dated.values())
        prepared.append((earliest, len(dated), group, dated))
    prepared.sort(key=lambda item: (item[0], item[1]))
    claimed: set[tuple[str, str, str]] = set()
    sessions: list[AgentSession] = []
    for _, _, group, dated in prepared:
        owned = [value for key, value in dated.items() if key not in claimed]
        claimed.update(dated)
        if owned:
            sessions.append(_fold(group, owned))
    sessions.sort(key=lambda session: session.ended_at, reverse=True)
    return sessions


def _session_files(root: Path, modified_since: datetime | None) -> list[Path]:
    """List a store's log files, optionally only those recently modified.

    The filter is per FILE mtime: a session whose log was touched inside the
    window reports its full-history totals, so a straddling session is never
    shown partially.
    """
    if not root.exists():
        return []
    paths: list[Path] = []
    for path in sorted(root.rglob("*.jsonl")):
        if modified_since is not None:
            try:
                mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
            except OSError:
                continue
            if mtime < modified_since:
                continue
        paths.append(path)
    return paths


def scan_sessions(
    *,
    claude_root: Path,
    codex_root: Path,
    modified_since: datetime | None = None,
) -> list[AgentSession]:
    """Scan both local stores into per-session rollups (absent roots skipped).

    Args:
        claude_root: The Claude Code projects directory (``~/.claude/projects``).
        codex_root: The Codex sessions directory (``~/.codex/sessions``).
        modified_since: When set, only log files modified at or after this
            instant are read — a cheap file-level window over multi-gigabyte
            histories.

    Returns:
        Sessions with any dated usage, most recently active first.
    """
    scans: list[SessionFileScan] = []
    scans.extend(scan_claude_file(path) for path in _session_files(claude_root, modified_since))
    scans.extend(scan_codex_file(path) for path in _session_files(codex_root, modified_since))
    return build_sessions(scans)


class LimitWindow(BaseModel):
    """One plan window's consumption at the latest observation."""

    model_config = ConfigDict(frozen=True)

    used_percent: float | None
    window_minutes: int | None
    resets_at: datetime | None


class CodexLimitStatus(BaseModel):
    """Latest observed Codex plan-limit state for one limit id.

    ``limit_reached`` and ``spend_control_reached`` are the switch-now
    signals: both stay null/false until the backend rejects a call.
    """

    model_config = ConfigDict(frozen=True)

    limit_id: str | None
    plan_type: str | None
    primary: LimitWindow | None
    secondary: LimitWindow | None
    has_credits: bool | None
    limit_reached: str | None
    spend_control_reached: bool | None
    observed_at: datetime


class ClaudeApiErrorStatus(BaseModel):
    """Aggregated Claude Code API-failure counts for one error kind.

    A limit hit surfaces here as its own kind the moment one occurs; kinds
    are short enum-like strings from the transcript, never message text.
    """

    model_config = ConfigDict(frozen=True)

    kind: str
    count: int = Field(ge=0)
    last_seen: datetime


class LimitsReport(BaseModel):
    """Local credential health: plan windows plus API-failure counts."""

    model_config = ConfigDict(frozen=True)

    codex: tuple[CodexLimitStatus, ...]
    claude_api_errors: tuple[ClaudeApiErrorStatus, ...]


def _limit_window(state: WindowState | None) -> LimitWindow | None:
    """Project one scanned window state for display."""
    if state is None:
        return None
    return LimitWindow(
        used_percent=state.used_percent,
        window_minutes=state.window_minutes,
        resets_at=_resets_at(state),
    )


def collect_limits(
    *,
    claude_root: Path,
    codex_root: Path,
    modified_since: datetime | None = None,
) -> LimitsReport:
    """Read the latest credential-limit state from both local stores.

    Codex: the newest plan-limit observation per limit id across rollouts.
    Claude Code: API-failure counts by kind (rate limits included) with the
    last occurrence, so a hit is visible the moment a transcript records it.
    """
    codex_latest: dict[str | None, tuple[datetime, CodexLimitStatus]] = {}
    for path in _session_files(codex_root, modified_since):
        observation = scan_codex_file(path).limit_observation
        if observation is None:
            continue
        observed_at = _parse_timestamp(observation.observed_at)
        if observed_at is None:
            continue
        status = CodexLimitStatus(
            limit_id=observation.limit_id,
            plan_type=observation.plan_type,
            primary=_limit_window(observation.primary),
            secondary=_limit_window(observation.secondary),
            has_credits=observation.has_credits,
            limit_reached=observation.limit_reached,
            spend_control_reached=observation.spend_control_reached,
            observed_at=observed_at,
        )
        current = codex_latest.get(observation.limit_id)
        if current is None or observed_at > current[0]:
            codex_latest[observation.limit_id] = (observed_at, status)
    failures: dict[str, tuple[int, datetime]] = {}
    for path in _session_files(claude_root, modified_since):
        for event in scan_claude_file(path).api_errors:
            seen_at = _parse_timestamp(event.timestamp)
            if seen_at is None:
                continue
            count, last_seen = failures.get(event.kind, (0, seen_at))
            failures[event.kind] = (count + 1, max(last_seen, seen_at))
    codex = tuple(
        status
        for _, status in sorted(codex_latest.values(), key=lambda item: item[0], reverse=True)
    )
    claude = tuple(
        sorted(
            (
                ClaudeApiErrorStatus(kind=kind, count=count, last_seen=last_seen)
                for kind, (count, last_seen) in failures.items()
            ),
            key=lambda status: status.last_seen,
            reverse=True,
        )
    )
    return LimitsReport(codex=codex, claude_api_errors=claude)
