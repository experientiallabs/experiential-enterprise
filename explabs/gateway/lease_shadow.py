# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Shadow-mode budget leasing: measure a leased admission path, enforce nothing.

The money lane's last synchronous cost is the fail-closed budget reservation
(``gateway_start_attempt``): one Postgres round trip before every
platform-funded dispatch. A *budget lease* would amortize it — each worker
holds a small, TTL-bounded slice of the scope's remaining budget in memory and
admits against that slice at memory speed, falling back to the synchronous
reservation whenever the lease cannot answer.

This module is that design **as a shadow**: on every money-lane reservation it
computes what the lease would have decided and how long that took
(nanoseconds), while the real synchronous reservation still enforces every
dollar. Both decisions and both latencies are recorded so the go/no-go on real
enforcement rests on measured agreement, not argument. The shadow can never
refuse, admit, or delay a customer request:

* ``LeaseShadow.begin`` is a dict lookup and a few compares under one lock;
  any internal failure trips a latch that disables the shadow for the process.
* The lease state is *read* from the same Postgres truth the reservation
  enforces (``PostgresLeaseStateReader``; no new tables, no migration), on a
  background thread, never on the request path.

Design constraints mirrored from the enforcement proposal:

* Lease size is adaptive: ``min(cap, fraction x remaining scope budget)``.
* Scopes whose remaining budget sits below a floor (promo caps ~$10, the $1
  pre-verify allowance) stay synchronous — the shadow abstains for them.
* Leases expire after a short TTL (5-10 s) so revocation/drain lag is bounded;
  an expired or absent lease abstains to the synchronous path (the default).
* Sync-only scopes the lease deliberately does not model (active promotions,
  per-scope monthly budgets, tokens-per-minute) abstain with a named reason.
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Any, ClassVar, LiteralString, Protocol

from explabs.gateway.db import GatewayDatabase

logger = logging.getLogger(__name__)

# SQLSTATEs that mean the real reservation REFUSED for a money/authority
# reason (the shadow's "deny" domain). Anything else raised by the reservation
# is an infrastructure or invariant error and is excluded from agreement.
_REFUSAL_SQLSTATES = frozenset(
    {
        "P1010",
        "P1011",
        "P1012",
        "P1013",
        "P1014",
        "P1015",
        "P1016",
        "P1017",
        "P1018",
        "P1019",
        "P1022",
        "P1023",
        "P1024",
        "P1025",
        "P1030",
        "P1031",
        "42501",
    }
)


@dataclass(frozen=True)
class LeaseShadowConfig:
    """Tunables for the shadow lease, mirroring the enforcement proposal."""

    # Fraction of the scope's remaining budget one worker may lease at once.
    lease_fraction: float = 0.10
    # Absolute per-lease ceiling, micro-USD ($2): bounds worst-case overspend
    # per worker per TTL window if enforcement ever trusted the lease.
    lease_cap_micro_usd: int = 2_000_000
    # Scopes with less remaining than this ($10) stay synchronous: promo caps
    # and the pre-verify allowance live below it, and near-drained scopes are
    # exactly where a stale lease would overspend.
    floor_micro_usd: int = 10_000_000
    # Lease lifetime; refresh runs at half this cadence so live keys stay warm.
    ttl_seconds: float = 6.0
    # Leased admission keeps this much headroom under a requests-per-minute
    # limit; the band above it abstains to the synchronous counter.
    rate_headroom: float = 0.9
    # Bounds for tracked lease keys and retained latency samples.
    max_tracked_keys: int = 1024
    sample_capacity: int = 65_536
    # At most this many divergences are retained verbatim for the report.
    max_divergence_details: int = 50


@dataclass(frozen=True, slots=True)
class LeaseKey:
    """One admission scope as the money lane sees it at reservation time."""

    org_id: str
    api_key_id: str
    alias: str
    provider: str
    exact_model_id: str


class ShadowVerdict(Enum):
    """What the leased admission path would have done."""

    ADMIT = "admit"
    DENY = "deny"
    SYNC_FALLBACK = "sync"


@dataclass(frozen=True)
class LeaseSourceState:
    """One refresh read of the Postgres truth governing a lease key.

    ``remaining_micro_usd`` is the tightest money headroom across the scopes a
    lease can model (credit balance net of outstanding reservations, the
    free-credit daily org/model caps, and an explicit per-key daily cap).
    ``exclusion_reasons`` names sync-only scopes that govern this key; a
    non-empty tuple makes every shadow decision abstain.
    """

    remaining_micro_usd: int
    exclusion_reasons: tuple[str, ...] = ()
    requests_per_minute: int | None = None


class LeaseStateReader(Protocol):
    """Reads the budget truth a lease grant derives from."""

    def read(self, keys: Sequence[LeaseKey]) -> dict[LeaseKey, LeaseSourceState]:
        """Return the current source state for each key, omitting failures."""
        ...


@dataclass
class _Lease:
    """One in-memory lease slice for one admission scope."""

    granted_micro_usd: int
    consumed_micro_usd: int
    remaining_at_grant_micro_usd: int
    exclusion_reasons: tuple[str, ...]
    requests_per_minute: int | None
    expires_monotonic: float
    last_used_monotonic: float


@dataclass(frozen=True)
class ShadowDivergence:
    """One shadow-vs-real disagreement, content-free."""

    verdict: ShadowVerdict
    reason: str
    sqlstate: str | None
    max_cost_micro_usd: int
    org_id: str
    alias: str


@dataclass(frozen=True)
class LatencySummary:
    """Microsecond percentiles over one latency series."""

    count: int
    p50_us: float
    p90_us: float
    p99_us: float
    max_us: float

    @staticmethod
    def of_nanoseconds(samples: Sequence[int]) -> LatencySummary | None:
        """Summarize nanosecond samples in microseconds; None when empty."""
        if not samples:
            return None
        ordered = sorted(samples)

        def at(quantile: float) -> float:
            index = min(len(ordered) - 1, math.ceil(quantile * len(ordered)) - 1)
            return ordered[max(0, index)] / 1_000

        return LatencySummary(
            count=len(ordered),
            p50_us=at(0.50),
            p90_us=at(0.90),
            p99_us=at(0.99),
            max_us=ordered[-1] / 1_000,
        )


@dataclass(frozen=True)
class LeaseShadowReport:
    """Cumulative shadow-vs-real comparison for one worker process."""

    samples: int
    verdicts: dict[str, int]
    sync_reasons: dict[str, int]
    # Agreement is computed over decisive shadow verdicts only (admit/deny);
    # an abstain is the sync path by definition and can never disagree.
    comparable: int
    agreements: int
    divergences: tuple[ShadowDivergence, ...]
    divergence_count: int
    # Worst-case dollars a lease-admitted-but-really-refused request would
    # have dispatched: the measured bounded overspend of enforcement.
    would_be_overspend_micro_usd: int
    # DENY verdicts the real reservation admitted: would-be false 429s.
    false_denials: int
    # Real refusals outside agreement because the shadow abstained (sync path
    # decided, as designed) and infrastructure errors excluded entirely.
    infrastructure_errors: int
    outstanding_lease_micro_usd: int
    shadow_latency: LatencySummary | None
    real_latency: LatencySummary | None

    @property
    def agreement_rate(self) -> float | None:
        """Fraction of decisive shadow verdicts the real reservation matched."""
        if self.comparable == 0:
            return None
        return self.agreements / self.comparable

    def to_json(self) -> str:
        """Serialize for the periodic worker log line and run artifacts."""

        def latency(summary: LatencySummary | None) -> dict[str, float] | None:
            if summary is None:
                return None
            return {
                "count": summary.count,
                "p50_us": round(summary.p50_us, 2),
                "p90_us": round(summary.p90_us, 2),
                "p99_us": round(summary.p99_us, 2),
                "max_us": round(summary.max_us, 2),
            }

        rate = self.agreement_rate
        return json.dumps(
            {
                "samples": self.samples,
                "verdicts": self.verdicts,
                "sync_reasons": self.sync_reasons,
                "comparable": self.comparable,
                "agreement_rate": None if rate is None else round(rate, 6),
                "divergence_count": self.divergence_count,
                "would_be_overspend_micro_usd": self.would_be_overspend_micro_usd,
                "false_denials": self.false_denials,
                "infrastructure_errors": self.infrastructure_errors,
                "outstanding_lease_micro_usd": self.outstanding_lease_micro_usd,
                "shadow_latency": latency(self.shadow_latency),
                "real_latency": latency(self.real_latency),
            }
        )


class ShadowProbe:
    """One reservation's shadow decision, awaiting the real outcome.

    Created by :meth:`LeaseShadow.begin` immediately before the synchronous
    reservation; exactly one ``settle_*`` call records the comparison. The
    probe's clock starts at construction so ``real_ns`` measures the full
    synchronous cost the lease would replace (pool checkout included).
    """

    __slots__ = ("_key", "_max_cost", "_reason", "_shadow", "_shadow_ns", "_started_ns", "_verdict")

    def __init__(
        self,
        shadow: LeaseShadow,
        key: LeaseKey,
        max_cost: int | None,
        verdict: ShadowVerdict,
        reason: str,
        shadow_ns: int,
    ) -> None:
        """Bind one decision and start the real-path clock."""
        self._shadow = shadow
        self._key = key
        self._max_cost = max_cost
        self._verdict = verdict
        self._reason = reason
        self._shadow_ns = shadow_ns
        self._started_ns = time.perf_counter_ns()

    @property
    def verdict(self) -> ShadowVerdict:
        """The would-be lease decision (tests and diagnostics)."""
        return self._verdict

    @property
    def reason(self) -> str:
        """Why the shadow decided or abstained (tests and diagnostics)."""
        return self._reason

    def settle_admitted(self) -> None:
        """Record that the real reservation admitted (returned an attempt)."""
        self._settle(sqlstate=None)

    def settle_refused(self, sqlstate: str | None) -> None:
        """Record the real reservation's raised SQLSTATE."""
        self._settle(sqlstate=sqlstate or "unknown")

    def _settle(self, *, sqlstate: str | None) -> None:
        real_ns = time.perf_counter_ns() - self._started_ns
        self._shadow._observe(  # noqa: SLF001 - probe is the shadow's own seam
            key=self._key,
            max_cost=self._max_cost,
            verdict=self._verdict,
            reason=self._reason,
            shadow_ns=self._shadow_ns,
            real_ns=real_ns,
            sqlstate=sqlstate,
        )


class LeaseShadow:
    """In-memory lease admission computed in parallel with the real gate.

    Thread-safe: ``begin`` runs on reservation threads; the refresher runs on
    one daemon thread. All shared state sits behind two locks (lease map and
    stats), each held only for constant-time work.
    """

    def __init__(
        self,
        reader: LeaseStateReader,
        *,
        config: LeaseShadowConfig | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        auto_refresh: bool = True,
    ) -> None:
        """Bind the state reader and tunables.

        Args:
            reader: Source of the Postgres budget truth for lease grants.
            config: Tunables; defaults mirror the enforcement proposal.
            monotonic: Injectable clock for TTL and rate windows (tests).
            auto_refresh: Start the background refresher on first use. Tests
                pass False and drive :meth:`refresh_once` deterministically.
        """
        self._reader = reader
        self._config = config or LeaseShadowConfig()
        self._monotonic = monotonic
        self._auto_refresh = auto_refresh
        self._broken = False

        self._lease_lock = threading.Lock()
        self._leases: dict[LeaseKey, _Lease] = {}
        self._pending_keys: set[LeaseKey] = set()
        # Shadow-admitted dispatch stamps per API KEY (not per lease key):
        # gateway_start_attempt's RPM guard counts every host-lane attempt of
        # the key across aliases, providers, and waterfall rungs, so the
        # shadow's window must aggregate the same way or one key split across
        # routes would shadow-admit past the real limit. Pruned to the
        # trailing 60 s on use and to live keys on refresh.
        self._rpm_windows: dict[str, deque[float]] = {}

        self._stats_lock = threading.Lock()
        self._verdict_counts: dict[str, int] = {}
        self._sync_reasons: dict[str, int] = {}
        self._comparable = 0
        self._agreements = 0
        self._divergences: list[ShadowDivergence] = []
        self._divergence_count = 0
        self._would_be_overspend = 0
        self._false_denials = 0
        self._infrastructure_errors = 0
        self._samples = 0
        self._shadow_ns: list[int] = []
        self._real_ns: list[int] = []
        self._logged_samples = 0

        self._refresher_lock = threading.Lock()
        self._refresher: threading.Thread | None = None
        self._stop = threading.Event()

    # -- hot path -----------------------------------------------------------------

    def begin(self, key: LeaseKey, max_cost_micro_usd: int | None) -> ShadowProbe | None:
        """Decide what the lease would do and open the real-path clock.

        Never raises and never blocks beyond one uncontended lock: any
        internal failure disables the shadow for the process and the money
        path continues untouched.
        """
        if self._broken:
            return None
        try:
            self._ensure_refresher()
            started = time.perf_counter_ns()
            verdict, reason = self._decide(key, max_cost_micro_usd)
            shadow_ns = time.perf_counter_ns() - started
            return ShadowProbe(self, key, max_cost_micro_usd, verdict, reason, shadow_ns)
        except Exception:
            self._broken = True
            logger.exception("lease shadow failed and is disabled for this process")
            return None

    def _decide(self, key: LeaseKey, max_cost: int | None) -> tuple[ShadowVerdict, str]:
        """The would-be lease admission: constant-time, in memory."""
        if max_cost is None:
            # A null worst-case price is decidable locally with perfect
            # fidelity: the real gate fails closed (P1013) before any read.
            return ShadowVerdict.DENY, "price_unknown"
        now = self._monotonic()
        with self._lease_lock:
            lease = self._leases.get(key)
            if lease is None:
                # Bounded registration: overflow keys simply stay on the
                # synchronous path until tracked keys free up, so a burst of
                # distinct scopes can never grow the refresh batch unbounded.
                if len(self._pending_keys) < self._config.max_tracked_keys:
                    self._pending_keys.add(key)
                return ShadowVerdict.SYNC_FALLBACK, "no_lease"
            lease.last_used_monotonic = now
            return self._admit_against(key, lease, max_cost, now)

    def _admit_against(
        self, key: LeaseKey, lease: _Lease, max_cost: int, now: float
    ) -> tuple[ShadowVerdict, str]:
        """Admit against one live lease (called under the lease lock)."""
        if now >= lease.expires_monotonic:
            verdict = (ShadowVerdict.SYNC_FALLBACK, "lease_expired")
        elif lease.exclusion_reasons:
            reason = "excluded:" + ",".join(lease.exclusion_reasons)
            verdict = (ShadowVerdict.SYNC_FALLBACK, reason)
        elif lease.remaining_at_grant_micro_usd <= 0:
            verdict = (ShadowVerdict.DENY, "scope_exhausted")
        elif lease.remaining_at_grant_micro_usd < self._config.floor_micro_usd:
            verdict = (ShadowVerdict.SYNC_FALLBACK, "below_floor")
        elif self._rate_limited(key.api_key_id, lease.requests_per_minute, now):
            verdict = (ShadowVerdict.SYNC_FALLBACK, "rate_headroom")
        elif lease.consumed_micro_usd + max_cost > lease.granted_micro_usd:
            verdict = (ShadowVerdict.SYNC_FALLBACK, "lease_exhausted")
        else:
            lease.consumed_micro_usd += max_cost
            if lease.requests_per_minute is not None:
                self._rpm_windows.setdefault(key.api_key_id, deque()).append(now)
            verdict = (ShadowVerdict.ADMIT, "admit")
        return verdict

    def _rate_limited(self, api_key_id: str, rpm: int | None, now: float) -> bool:
        """Whether one more admit would leave the RPM headroom band (locked).

        The window is per API key, matching the enforcing guard's scope: it
        sums the key's shadow-admitted dispatches across every alias,
        provider, and waterfall rung it serves.
        """
        if rpm is None:
            return False
        stamps = self._rpm_windows.get(api_key_id)
        if stamps is None:
            return False
        while stamps and stamps[0] <= now - 60.0:
            stamps.popleft()
        return len(stamps) + 1 > rpm * self._config.rate_headroom

    def _observe(
        self,
        *,
        key: LeaseKey,
        max_cost: int | None,
        verdict: ShadowVerdict,
        reason: str,
        shadow_ns: int,
        real_ns: int,
        sqlstate: str | None,
    ) -> None:
        """Fold one settled comparison into the cumulative report."""
        if self._broken:
            return
        try:
            real_refused = sqlstate is not None
            infrastructure = real_refused and sqlstate not in _REFUSAL_SQLSTATES
            with self._stats_lock:
                self._samples += 1
                self._verdict_counts[verdict.value] = self._verdict_counts.get(verdict.value, 0) + 1
                if verdict is ShadowVerdict.SYNC_FALLBACK:
                    self._sync_reasons[reason] = self._sync_reasons.get(reason, 0) + 1
                if len(self._shadow_ns) < self._config.sample_capacity:
                    self._shadow_ns.append(shadow_ns)
                    self._real_ns.append(real_ns)
                if infrastructure:
                    self._infrastructure_errors += 1
                elif verdict is not ShadowVerdict.SYNC_FALLBACK:
                    self._comparable += 1
                    agreed = (verdict is ShadowVerdict.ADMIT) == (not real_refused)
                    if agreed:
                        self._agreements += 1
                    else:
                        self._divergence_count += 1
                        if verdict is ShadowVerdict.ADMIT:
                            self._would_be_overspend += max_cost or 0
                        else:
                            self._false_denials += 1
                        if len(self._divergences) < self._config.max_divergence_details:
                            self._divergences.append(
                                ShadowDivergence(
                                    verdict=verdict,
                                    reason=reason,
                                    sqlstate=sqlstate,
                                    max_cost_micro_usd=max_cost or 0,
                                    org_id=key.org_id,
                                    alias=key.alias,
                                )
                            )
        except Exception:
            self._broken = True
            logger.exception("lease shadow failed and is disabled for this process")

    # -- background refresh -------------------------------------------------------

    def refresh_once(self) -> None:
        """Re-grant every tracked lease from the current Postgres truth.

        Runs on the refresher thread in production; tests call it directly.
        Reader failures leave existing leases to expire on their TTL, which is
        the design's bounded-staleness answer to a slow or absent database.
        The batch is capped at ``max_tracked_keys``, ranked by recency —
        pending registrations were just requested, then live leases by their
        last decision — so one refresh cycle's database work is bounded
        regardless of how many distinct scopes a burst produced. Leases that
        lose their slot are dropped and fall back to the synchronous path.
        """
        with self._lease_lock:
            pending = sorted(self._pending_keys, key=lambda key: (key.org_id, key.api_key_id))
            self._pending_keys.clear()
            ranked = sorted(
                self._leases, key=lambda key: self._leases[key].last_used_monotonic, reverse=True
            )
            keys = list(dict.fromkeys(pending + ranked))[: self._config.max_tracked_keys]
            for key in [tracked for tracked in self._leases if tracked not in set(keys)]:
                del self._leases[key]
        if not keys:
            return
        states = self._reader.read(keys)
        granted_at = self._monotonic()
        with self._lease_lock:
            for key, state in states.items():
                remaining = state.remaining_micro_usd
                granted = min(
                    self._config.lease_cap_micro_usd,
                    int(remaining * self._config.lease_fraction),
                )
                previous = self._leases.get(key)
                self._leases[key] = _Lease(
                    granted_micro_usd=max(granted, 0),
                    consumed_micro_usd=0,
                    remaining_at_grant_micro_usd=remaining,
                    exclusion_reasons=state.exclusion_reasons,
                    requests_per_minute=state.requests_per_minute,
                    expires_monotonic=granted_at + self._config.ttl_seconds,
                    # A re-grant is not a use: recency belongs to decisions,
                    # or the ranking above could never tell hot from idle.
                    last_used_monotonic=(
                        previous.last_used_monotonic if previous is not None else granted_at
                    ),
                )
            # RPM windows outlive individual lease re-grants (the enforcing
            # counter is a trailing 60 s of real attempts) but not the keys
            # themselves: drop windows for API keys with no tracked lease.
            live_api_keys = {key.api_key_id for key in self._leases}
            for api_key_id in [key for key in self._rpm_windows if key not in live_api_keys]:
                del self._rpm_windows[api_key_id]

    def _ensure_refresher(self) -> None:
        """Start the single background refresher once (auto mode only)."""
        if not self._auto_refresh or self._refresher is not None:
            return
        with self._refresher_lock:
            if self._refresher is not None:
                return
            thread = threading.Thread(
                target=self._refresh_loop,
                name="gateway-lease-shadow-refresher",
                daemon=True,
            )
            self._refresher = thread
            thread.start()

    def _refresh_loop(self) -> None:
        """Refresh at half the TTL and log the running report each cycle.

        The first cycle runs almost immediately: the thread starts on the
        first shadowed reservation, whose key is pending by the time the
        short first wait elapses, so cold-start ``no_lease`` abstains span
        milliseconds instead of a whole refresh interval.
        """
        interval = 0.1
        while not self._stop.wait(interval):
            interval = self._config.ttl_seconds / 2
            try:
                self.refresh_once()
            except Exception:
                # A failed refresh only lets leases expire; keep shadowing.
                logger.exception("lease shadow refresh failed; leases will expire")
            with self._stats_lock:
                fresh = self._samples > self._logged_samples
                self._logged_samples = self._samples
            if fresh:
                logger.info("lease-shadow %s", self.report().to_json())

    def stop(self, timeout_seconds: float = 10.0) -> bool:
        """Stop the refresher thread and wait for it to exit (tests/drains).

        Returns:
            True when the thread exited (or never started) inside the timeout.
        """
        self._stop.set()
        thread = self._refresher
        if thread is None:
            return True
        thread.join(timeout=timeout_seconds)
        return not thread.is_alive()

    # -- reporting ----------------------------------------------------------------

    def report(self) -> LeaseShadowReport:
        """Snapshot the cumulative shadow-vs-real comparison."""
        with self._lease_lock:
            outstanding = sum(
                min(lease.consumed_micro_usd, lease.granted_micro_usd)
                for lease in self._leases.values()
            )
        with self._stats_lock:
            return LeaseShadowReport(
                samples=self._samples,
                verdicts=dict(self._verdict_counts),
                sync_reasons=dict(self._sync_reasons),
                comparable=self._comparable,
                agreements=self._agreements,
                divergences=tuple(self._divergences),
                divergence_count=self._divergence_count,
                would_be_overspend_micro_usd=self._would_be_overspend,
                false_denials=self._false_denials,
                infrastructure_errors=self._infrastructure_errors,
                outstanding_lease_micro_usd=outstanding,
                shadow_latency=LatencySummary.of_nanoseconds(self._shadow_ns),
                real_latency=LatencySummary.of_nanoseconds(self._real_ns),
            )


class PostgresLeaseStateReader:
    """Reads lease source state from the SAME truth the reservation enforces.

    One read-only query per key against existing tables and functions (no
    migration): the org's credit balance net of outstanding reservations, the
    free-credit daily caps, an explicit per-key daily cap, and the sync-only
    exclusion signals (pre-verify spend gate, per-scope monthly budgets,
    active promotions, tokens-per-minute limits).
    """

    # Mirrors gateway_spend_policy_check's free-credit daily caps.
    _ORG_DAILY_CAP_MICRO_USD = 50_000_000
    _MODEL_DAILY_CAP_MICRO_USD = 25_000_000

    _QUERY: ClassVar[LiteralString] = """
        with day as (
          select pg_catalog.date_trunc(
            'day', pg_catalog.clock_timestamp() at time zone 'UTC'
          ) at time zone 'UTC' as start
        )
        select
          pg_catalog.round((orgs.credit_granted_usd - orgs.billable_spend_usd)
            * 1000000)::pg_catalog.int8 as balance_micro_usd,
          coalesce((
            select pg_catalog.sum(attempts.budget_reserved_micro_usd)
              from public.gateway_attempts attempts
             where attempts.org_id = orgs.id
               and attempts.state = 'dispatched'
               and attempts.billing_source = 'host_managed'), 0) as outstanding,
          public.gateway_org_free_credit_funded(orgs.id) as free_funded,
          (orgs.spend_unlocked_at is null and exists (
             select 1 from public.organization_members members
              where members.org_id = orgs.id
                and members.role = 'admin')) as pre_verify_gated,
          exists (
            select 1 from public.gateway_budgets budgets
             where budgets.org_id = orgs.id) as has_budget_rows,
          (select promo.is_promo
             from public.gateway_promo_state(orgs.id, %(alias)s, %(provider)s, 0)
             promo) as is_promo,
          limits.api_key_id is not null as has_limits_row,
          limits.requests_per_minute,
          limits.tokens_per_minute,
          limits.daily_spend_cap_micro_usd,
          coalesce((
            select pg_catalog.sum(
              case when attempts.state = 'dispatched'
                then attempts.budget_reserved_micro_usd
                else coalesce(attempts.budget_settled_micro_usd, 0) end)
              from public.gateway_attempts attempts, day
             where attempts.org_id = orgs.id
               and attempts.billing_source = 'host_managed'
               and attempts.budget_period_start = day.start), 0) as org_today,
          coalesce((
            select pg_catalog.sum(
              case when attempts.state = 'dispatched'
                then attempts.budget_reserved_micro_usd
                else coalesce(attempts.budget_settled_micro_usd, 0) end)
              from public.gateway_attempts attempts, day
             where attempts.org_id = orgs.id
               and attempts.billing_source = 'host_managed'
               and attempts.budget_period_start = day.start
               and attempts.exact_model_id = %(exact_model_id)s), 0) as model_today,
          coalesce((
            select pg_catalog.sum(
              case when attempts.state = 'dispatched'
                then attempts.budget_reserved_micro_usd
                else coalesce(attempts.budget_settled_micro_usd, 0) end)
              from public.gateway_attempts attempts, day
             where attempts.api_key_id = %(api_key_id)s::uuid
               and attempts.billing_source = 'host_managed'
               and attempts.budget_period_start = day.start), 0) as key_today
        from public.organizations orgs
        left join public.gateway_key_limits limits
          on limits.api_key_id = %(api_key_id)s::uuid
        where orgs.id = %(org_id)s::uuid
    """

    def __init__(self, db: GatewayDatabase) -> None:
        """Bind the worker's shared pooled database."""
        self._db = db

    # Keys read per pooled-connection checkout: the refresher shares the
    # reservation pool, so one refresh must never pin a connection for the
    # whole (bounded) batch — chunking releases it between slices.
    _CHUNK_SIZE = 64

    def read(self, keys: Sequence[LeaseKey]) -> dict[LeaseKey, LeaseSourceState]:
        """Read the current source state for each key; skip vanished orgs."""
        states: dict[LeaseKey, LeaseSourceState] = {}
        for start in range(0, len(keys), self._CHUNK_SIZE):
            chunk = keys[start : start + self._CHUNK_SIZE]
            with self._db.atomic_call() as cursor:
                for key in chunk:
                    cursor.execute(
                        self._QUERY,
                        {
                            "org_id": key.org_id,
                            "api_key_id": key.api_key_id,
                            "alias": key.alias,
                            "provider": key.provider,
                            "exact_model_id": key.exact_model_id,
                        },
                    )
                    row = cursor.fetchone()
                    if row is None:
                        # A vanished org cannot spend; the real gate refuses it.
                        states[key] = LeaseSourceState(remaining_micro_usd=0)
                        continue
                    states[key] = self._state_of(row)
        return states

    def _state_of(self, row: tuple[Any, ...]) -> LeaseSourceState:
        """Validate one raw driver row into the typed lease source state."""
        (
            balance_micro_usd,
            outstanding,
            free_funded,
            pre_verify_gated,
            has_budget_rows,
            is_promo,
            has_limits_row,
            requests_per_minute,
            tokens_per_minute,
            daily_spend_cap_micro_usd,
            org_today,
            model_today,
            key_today,
        ) = row
        remaining = int(balance_micro_usd) - int(outstanding)
        if bool(free_funded):
            remaining = min(
                remaining,
                self._ORG_DAILY_CAP_MICRO_USD - int(org_today),
                self._MODEL_DAILY_CAP_MICRO_USD - int(model_today),
            )
        if daily_spend_cap_micro_usd is not None:
            remaining = min(remaining, int(daily_spend_cap_micro_usd) - int(key_today))
        reasons: list[str] = []
        if bool(pre_verify_gated):
            reasons.append("pre_verify")
        if bool(has_budget_rows):
            reasons.append("scope_budgets")
        if bool(is_promo):
            reasons.append("promo")
        if tokens_per_minute is not None:
            reasons.append("tpm")
        # A key with no limits row runs under the default 60 requests/minute.
        rpm = requests_per_minute if bool(has_limits_row) else 60
        return LeaseSourceState(
            remaining_micro_usd=remaining,
            exclusion_reasons=tuple(reasons),
            requests_per_minute=None if rpm is None else int(rpm),
        )
