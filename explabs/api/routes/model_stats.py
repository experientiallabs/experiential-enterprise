# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Observed catalog stats computed from the gateway usage ledger.

The models catalog carries three measured per-route stats — throughput
(tok/s), 30-day uptime, and p50 latency — on every ``model_providers`` row,
with a ``stats_source`` label. Seeded rows carry OpenRouter-labeled values
(``stats_source = 'openrouter'``); this module derives the *observed* values
from our own serving and overlays them at read time.

The source is ``gateway_usage_events`` — the canonical, content-free
per-request ledger the settlement transaction emits — aggregated cross-org
per ``(alias, provider)`` route by the ``gateway_observed_model_stats`` RPC
in ONE round trip (uptime = completed/terminal; throughput and latency are
``percentile_cont(0.5)`` over completed events, interpolating exactly like
Python's ``statistics.median``). One query per catalog read is a hard
invariant here: the 2026-08-22 capacity incident traced to this module's
previous implementation, which offset-walked the entire 30-day window
through PostgREST and accumulated every row in api memory, from ANONYMOUS
storefront traffic. Never reintroduce a row-level read on this path.

A route is only surfaced once it has at least ``MIN_OBSERVED_SAMPLE`` terminal
events in the window (enforced inside the RPC), so a single request never
becomes a headline number; a route below the floor keeps its seeded values
(or renders ``—``). This is a read-time overlay: nothing here writes the
ledger or the catalog.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import JsonObject, SupabaseClient, result_rows

# Trailing window the observed stats aggregate over. Matches the catalog's
# ``uptime_30d`` column semantics so an observed uptime reads on the same
# 30-day basis as a seeded one.
OBSERVED_WINDOW = timedelta(days=30)

# A route needs at least this many terminal events in the window before its
# observed stats are surfaced: below it, a p50 and a success ratio are noise,
# so the route keeps its seeded values or renders as unknown.
MIN_OBSERVED_SAMPLE = 20


class ObservedModelStat(BaseModel):
    """Observed stats for one ``(alias, provider)`` route over the window."""

    model_config = ConfigDict(frozen=True)

    # p50 end-to-end throughput in tokens/second; None when no completed event
    # carried both output tokens and a positive latency.
    throughput_tps: float | None
    # Completed / all-terminal events, as a 0..100 percentage.
    uptime_30d: float
    # p50 end-to-end latency in milliseconds; None when unmeasured.
    latency_p50_ms: float | None
    # Terminal events observed in the window (the sample behind the numbers).
    sample_count: int


class _ObservedStatRow(BaseModel):
    """Typed projection of one ``gateway_observed_model_stats`` RPC row."""

    model_config = ConfigDict(frozen=True)

    alias: str
    provider: str
    sample_count: int
    completed_count: int
    latency_p50_ms: float | None = None
    throughput_p50_tps: float | None = None

    @classmethod
    def from_row(cls, row: JsonObject) -> _ObservedStatRow:
        """Validate one aggregate row at the read boundary."""
        return cls.model_validate(dict(row))


def fetch_observed_stats(
    client: SupabaseClient,
    *,
    now: datetime | None = None,
) -> dict[tuple[str, str], ObservedModelStat]:
    """Load the recent usage window's observed catalog stats in one query.

    The ``gateway_observed_model_stats`` RPC aggregates ``gateway_usage_events``
    cross-org in the database (the service-role catalog read builds public
    stats; only aggregates are exposed, never per-org rows) over the trailing
    ``OBSERVED_WINDOW``. Exactly one round trip regardless of window size —
    see the module docstring for why that invariant is load-bearing.

    Args:
        client: Supabase client (service role).
        now: Window anchor; defaults to the current UTC time.

    Returns:
        Observed stats keyed by ``(alias, provider)``.
    """
    anchor = now or datetime.now(tz=UTC)
    after = (anchor - OBSERVED_WINDOW).isoformat()
    result = client.rpc(
        "gateway_observed_model_stats",
        {"in_after": after, "in_min_sample": MIN_OBSERVED_SAMPLE},
    ).execute()
    stats: dict[tuple[str, str], ObservedModelStat] = {}
    for raw in result_rows(result):
        row = _ObservedStatRow.from_row(raw)
        stats[(row.alias, row.provider)] = ObservedModelStat(
            throughput_tps=row.throughput_p50_tps,
            uptime_30d=100.0 * row.completed_count / row.sample_count,
            latency_p50_ms=row.latency_p50_ms,
            sample_count=row.sample_count,
        )
    return stats


def overlay_deployment_row(
    row: JsonObject,
    alias: str,
    stats: Mapping[tuple[str, str], ObservedModelStat],
) -> JsonObject:
    """Return a deployment row with observed stats applied when available.

    When the route ``(alias, provider)`` has observed stats, they replace the
    row's throughput/uptime/latency and stamp ``stats_source = 'observed'``;
    the three measured fields then read from one coherent source. Otherwise
    the row is returned unchanged (keeping any seeded OpenRouter values).
    """
    provider = row.get("provider")
    if provider is None:
        return row
    stat = stats.get((alias, str(provider)))
    if stat is None:
        return row
    return {
        **row,
        "uptime_30d": stat.uptime_30d,
        "throughput_tps": stat.throughput_tps,
        "latency_p50_ms": stat.latency_p50_ms,
        "stats_source": "observed",
    }
