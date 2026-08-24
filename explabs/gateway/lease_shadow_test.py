# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the shadow-mode budget lease (measure-only admission path)."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import Sequence

import pytest
from exp.common.models import ModelCapabilities
from exp.common.models.catalog import GatewayDeploymentMetadata, GatewayTokenPrices
from exp.common.models.gateway_catalog import BillingSource, ExactModelDeployment
from exp.runtime.gateway.budgets import BudgetReservationRejected
from exp.runtime.gateway.contracts import (
    AuthorizationSnapshot,
    ExecutionSnapshot,
    GatewayApiSurface,
    GatewayMessage,
    GatewayRequest,
)

from explabs.gateway.conftest import GatewayHarness, SeededAlias, SeededKey
from explabs.gateway.control_store import PostgresGatewayControlStore
from explabs.gateway.db import GatewayDatabase
from explabs.gateway.lease_shadow import (
    LeaseKey,
    LeaseShadow,
    LeaseShadowConfig,
    LeaseSourceState,
    PostgresLeaseStateReader,
    ShadowVerdict,
)
from explabs.gateway.ledger import PostgresAttemptLedger

_EXACT_MODEL_ID = "exact-one"


class _Clock:
    """Settable monotonic clock for TTL and rate-window tests."""

    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class _Reader:
    """Scriptable lease-state source."""

    def __init__(self) -> None:
        self.states: dict[LeaseKey, LeaseSourceState] = {}
        self.calls = 0

    def read(self, keys: Sequence[LeaseKey]) -> dict[LeaseKey, LeaseSourceState]:
        self.calls += 1
        return {key: self.states[key] for key in keys if key in self.states}


def _key(suffix: str = "a", *, api_key_id: str | None = None) -> LeaseKey:
    return LeaseKey(
        org_id=f"org-{suffix}",
        api_key_id=api_key_id if api_key_id is not None else f"key-{suffix}",
        alias=f"alias-{suffix}",
        provider="modal",
        exact_model_id=_EXACT_MODEL_ID,
    )


def _shadow(reader: _Reader, clock: _Clock, config: LeaseShadowConfig | None = None) -> LeaseShadow:
    return LeaseShadow(reader, config=config, monotonic=clock, auto_refresh=False)


def _decide(shadow: LeaseShadow, key: LeaseKey, max_cost: int | None) -> tuple[str, str]:
    """Run one decision through the public probe seam and settle it admitted."""
    probe = shadow.begin(key, max_cost)
    assert probe is not None
    probe.settle_admitted()
    return probe.verdict.value, probe.reason


def test_lease_lifecycle_abstains_admits_and_exhausts() -> None:
    """No lease abstains; a refill admits and debits; a spent lease abstains."""
    reader, clock = _Reader(), _Clock()
    shadow = _shadow(reader, clock)
    key = _key()
    # $20 remaining -> lease = min($2 cap, 10%) = $2 = 2_000_000.
    reader.states[key] = LeaseSourceState(remaining_micro_usd=20_000_000)

    assert _decide(shadow, key, 500_000) == ("sync", "no_lease")
    shadow.refresh_once()
    assert reader.calls == 1
    for _ in range(4):  # 4 x 500k consumes the full $2 lease
        assert _decide(shadow, key, 500_000) == ("admit", "admit")
    assert _decide(shadow, key, 500_000) == ("sync", "lease_exhausted")
    # The next refill re-grants from source truth and admission resumes.
    shadow.refresh_once()
    assert _decide(shadow, key, 500_000) == ("admit", "admit")


def test_ttl_expiry_abstains_until_the_next_refill() -> None:
    """A lease older than the TTL abstains; the refresher renews it."""
    reader, clock = _Reader(), _Clock()
    shadow = _shadow(reader, clock, LeaseShadowConfig(ttl_seconds=6.0))
    key = _key()
    reader.states[key] = LeaseSourceState(remaining_micro_usd=20_000_000)
    shadow.begin(key, 100)  # register
    shadow.refresh_once()
    assert _decide(shadow, key, 100) == ("admit", "admit")
    clock.now += 6.0
    assert _decide(shadow, key, 100) == ("sync", "lease_expired")
    shadow.refresh_once()
    assert _decide(shadow, key, 100) == ("admit", "admit")


def test_excluded_floor_zero_and_unpriced_scopes() -> None:
    """Sync-only scopes abstain; exhausted and unpriced scopes deny."""
    reader, clock = _Reader(), _Clock()
    shadow = _shadow(reader, clock)
    excluded, low, drained = _key("excluded"), _key("low"), _key("drained")
    reader.states[excluded] = LeaseSourceState(
        remaining_micro_usd=20_000_000, exclusion_reasons=("promo", "tpm")
    )
    # Below the $10 floor: the promo-cap / pre-verify territory stays sync.
    reader.states[low] = LeaseSourceState(remaining_micro_usd=9_999_999)
    reader.states[drained] = LeaseSourceState(remaining_micro_usd=0)
    for key in (excluded, low, drained):
        shadow.begin(key, 100)
    shadow.refresh_once()

    assert _decide(shadow, excluded, 100) == ("sync", "excluded:promo,tpm")
    assert _decide(shadow, low, 100) == ("sync", "below_floor")
    assert _decide(shadow, drained, 100) == ("deny", "scope_exhausted")
    # A null worst-case price is decidable locally without any lease.
    assert _decide(shadow, _key("unpriced"), None) == ("deny", "price_unknown")


def test_rate_headroom_abstains_near_the_rpm_limit() -> None:
    """Leased admission stops at 90% of the requests-per-minute limit."""
    reader, clock = _Reader(), _Clock()
    shadow = _shadow(reader, clock)
    key = _key()
    reader.states[key] = LeaseSourceState(remaining_micro_usd=20_000_000, requests_per_minute=10)
    shadow.begin(key, 100)
    shadow.refresh_once()
    for _ in range(9):
        assert _decide(shadow, key, 100) == ("admit", "admit")
    assert _decide(shadow, key, 100) == ("sync", "rate_headroom")
    # The window is trailing: a minute later admission resumes.
    clock.now += 60.0
    shadow.refresh_once()
    assert _decide(shadow, key, 100) == ("admit", "admit")


def test_rpm_window_aggregates_across_one_keys_routes() -> None:
    """The RPM window is per API key: split routes share one counter.

    ``gateway_start_attempt`` counts every host-lane attempt of the key,
    whatever alias, provider, or waterfall rung served it — so must the
    shadow, or one key spread across routes would shadow-admit past the
    real limit and contaminate agreement (Greptile P1 on #714).
    """
    reader, clock = _Reader(), _Clock()
    shadow = _shadow(reader, clock)
    alias_a = _key("route-a", api_key_id="key-shared")
    alias_b = _key("route-b", api_key_id="key-shared")
    for key in (alias_a, alias_b):
        reader.states[key] = LeaseSourceState(
            remaining_micro_usd=20_000_000, requests_per_minute=10
        )
        shadow.begin(key, 100)
    shadow.refresh_once()
    for _ in range(5):
        assert _decide(shadow, alias_a, 100) == ("admit", "admit")
    for _ in range(4):
        assert _decide(shadow, alias_b, 100) == ("admit", "admit")
    # 9 admits total across both routes: the 10th abstains on EITHER route.
    assert _decide(shadow, alias_b, 100) == ("sync", "rate_headroom")
    assert _decide(shadow, alias_a, 100) == ("sync", "rate_headroom")


def test_pending_registrations_are_bounded() -> None:
    """A burst of distinct scopes cannot grow the refresh batch unbounded."""
    reader, clock = _Reader(), _Clock()
    shadow = _shadow(reader, clock, LeaseShadowConfig(max_tracked_keys=2))
    for index in range(5):
        key = _key(f"burst-{index}")
        reader.states[key] = LeaseSourceState(remaining_micro_usd=20_000_000)
        shadow.begin(key, 100)
    shadow.refresh_once()
    # Only the bounded batch was read and leased; overflow keys stayed sync.
    assert reader.calls == 1
    leased = sum(
        1 for index in range(5) if _decide(shadow, _key(f"burst-{index}"), 100)[0] == "admit"
    )
    assert leased == 2


def test_report_counts_agreement_divergence_and_overspend() -> None:
    """Agreement is over decisive verdicts; divergences carry bounded overspend."""
    reader, clock = _Reader(), _Clock()
    shadow = _shadow(reader, clock)
    key = _key()
    reader.states[key] = LeaseSourceState(remaining_micro_usd=20_000_000)
    shadow.begin(key, 100)
    shadow.refresh_once()

    admit_agree = shadow.begin(key, 1_000)
    assert admit_agree is not None
    assert admit_agree.verdict is ShadowVerdict.ADMIT
    admit_agree.settle_admitted()
    admit_diverge = shadow.begin(key, 2_000)
    assert admit_diverge is not None
    assert admit_diverge.verdict is ShadowVerdict.ADMIT
    admit_diverge.settle_refused("P1010")
    deny_diverge = shadow.begin(key, None)  # price_unknown DENY
    assert deny_diverge is not None
    assert deny_diverge.verdict is ShadowVerdict.DENY
    deny_diverge.settle_admitted()
    sync_probe = shadow.begin(_key("unseen"), 100)
    assert sync_probe is not None
    assert sync_probe.verdict is ShadowVerdict.SYNC_FALLBACK
    sync_probe.settle_refused("P1016")
    infra = shadow.begin(key, 3_000)
    assert infra is not None
    infra.settle_refused("23514")  # invariant error: excluded from agreement

    report = shadow.report()
    assert report.samples == 5
    assert report.comparable == 3
    assert report.agreements == 1
    assert report.agreement_rate == pytest.approx(1 / 3)
    assert report.divergence_count == 2
    assert report.would_be_overspend_micro_usd == 2_000
    assert report.false_denials == 1
    assert report.infrastructure_errors == 1
    assert report.sync_reasons == {"no_lease": 1}
    assert report.shadow_latency is not None
    assert report.real_latency is not None
    assert report.shadow_latency.count == 5
    decoded = json.loads(report.to_json())
    assert decoded["agreement_rate"] == pytest.approx(1 / 3)
    assert decoded["would_be_overspend_micro_usd"] == 2_000
    divergence = report.divergences[0]
    assert divergence.sqlstate == "P1010"
    assert divergence.max_cost_micro_usd == 2_000


def test_auto_refresher_grants_quickly_and_stops_cleanly() -> None:
    """The background refresher leases a new key fast and stop() joins it.

    Uses the real clock: the first refresh cycle runs ~0.1s after the thread
    starts (on the first shadowed reservation), so cold-start ``no_lease``
    abstains span milliseconds, and ``stop`` leaves no thread behind.
    """
    reader = _Reader()
    key = _key()
    reader.states[key] = LeaseSourceState(remaining_micro_usd=20_000_000)
    shadow = LeaseShadow(reader, auto_refresh=True)
    first = shadow.begin(key, 100)
    assert first is not None
    assert first.verdict is ShadowVerdict.SYNC_FALLBACK
    deadline = time.monotonic() + 5
    admitted = False
    while time.monotonic() < deadline and not admitted:
        probe = shadow.begin(key, 100)
        assert probe is not None
        admitted = probe.verdict is ShadowVerdict.ADMIT
        time.sleep(0.02)
    assert admitted
    assert shadow.stop()


def test_internal_failure_disables_the_shadow_without_raising() -> None:
    """A shadow bug latches the shadow off; the money path never sees it."""

    def _boom_clock() -> float:
        msg = "injected shadow bug"
        raise RuntimeError(msg)

    shadow = LeaseShadow(_Reader(), monotonic=_boom_clock, auto_refresh=False)
    assert shadow.begin(_key(), 100) is None
    assert shadow.begin(_key(), 100) is None  # latched off


def test_tracked_keys_are_bounded_by_lru_eviction() -> None:
    """Beyond the tracking bound, the least recently used lease is dropped."""
    reader, clock = _Reader(), _Clock()
    shadow = _shadow(reader, clock, LeaseShadowConfig(max_tracked_keys=1))
    old, new = _key("old"), _key("new")
    reader.states[old] = LeaseSourceState(remaining_micro_usd=20_000_000)
    reader.states[new] = LeaseSourceState(remaining_micro_usd=20_000_000)
    shadow.begin(old, 100)
    shadow.refresh_once()
    clock.now += 1.0
    shadow.begin(new, 100)
    shadow.refresh_once()
    clock.now += 1.0
    shadow.refresh_once()
    assert _decide(shadow, new, 100)[0] == "admit"
    assert _decide(shadow, old, 100) == ("sync", "no_lease")


# -- integration: the shadow rides the real reservation seam ----------------------


def _request(content: str) -> GatewayRequest:
    """Build one bounded request whose content is never persisted."""
    return GatewayRequest(
        surface=GatewayApiSurface.CHAT_COMPLETIONS,
        messages=(GatewayMessage(role="user", content=content),),
        maximum_output_tokens=16,
    )


def _deployment(*, priced: bool = True) -> ExactModelDeployment:
    """Return one host-managed exact deployment with optional pricing."""
    prices = (
        GatewayTokenPrices(
            input_micro_usd_per_million_tokens=1_000_000,
            output_micro_usd_per_million_tokens=2_000_000,
        )
        if priced
        else GatewayTokenPrices()
    )
    return ExactModelDeployment(
        deployment_id="dep-primary",
        source_alias="dep-primary",
        exact_model_id=_EXACT_MODEL_ID,
        connection="connection-dep-primary",
        provider="openai-compatible",
        provider_model="provider-model",
        billing_source=BillingSource.HOST_MANAGED,
        connection_sha256="b" * 64,
        capabilities_sha256="d" * 64,
        capabilities=ModelCapabilities(maximum_output_tokens=16),
        gateway=GatewayDeploymentMetadata(prices=prices, pricing_source="test"),
    )


class _ShadowedAuthority:
    """One seeded org, key, and alias with a shadow-carrying ledger."""

    def __init__(self, harness: GatewayHarness, db: GatewayDatabase) -> None:
        self.harness = harness
        self.org_id: str = harness.seed_org()
        self.key: SeededKey = harness.seed_key(self.org_id, created_by=None)
        self.alias: SeededAlias = harness.activate_alias()
        self.store = PostgresGatewayControlStore(db)
        self.shadow = LeaseShadow(PostgresLeaseStateReader(db), auto_refresh=False)
        self.ledger = PostgresAttemptLedger(db, lease_shadow=self.shadow)

    def accepted(self) -> tuple[AuthorizationSnapshot, ExecutionSnapshot]:
        """Authorize and durably accept one unique request."""
        authorization = self.store.authorize_request(
            raw_key=self.key.raw_key,
            alias=self.alias.alias_name,
            request=_request(f"shadow {uuid.uuid4().hex}"),
            deadline_monotonic=time.monotonic() + 30,
        )
        self.ledger.accept_request_sync(authorization=authorization)
        snapshot = ExecutionSnapshot(
            authorization=authorization,
            exact_model_id=_EXACT_MODEL_ID,
            pool_id=self.alias.pool_id,
            deployment_ids=("dep-primary", "dep-secondary"),
        )
        return authorization, snapshot

    def start(self, *, maximum_cost_micro_usd: int | None = 200, priced: bool = True) -> str:
        """Accept one request and reserve one host-lane attempt."""
        _, snapshot = self.accepted()
        return self.ledger.start_attempt_sync(
            snapshot=snapshot,
            deployment=_deployment(priced=priced),
            attempt_ordinal=0,
            route_depth=0,
            maximum_cost_micro_usd=maximum_cost_micro_usd,
        )

    def drain_credits(self) -> None:
        """Spend the whole welcome grant so the balance gate refuses."""
        self.harness.connection.execute(
            """
            update public.organizations
               set billable_spend_usd = credit_granted_usd
             where id = %s
            """,
            (self.org_id,),
        )


@pytest.mark.integration
def test_shadow_agrees_with_the_real_reservation_end_to_end(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """Against real Postgres the shadow matches the enforcing reservation.

    Covers the four regimes: warm-lease admission, stale-lease divergence at
    the drain boundary (the bounded-overspend case), refreshed denial, and the
    locally decidable price-unknown refusal. Prints the latency comparison the
    go/no-go report cites.
    """
    authority = _ShadowedAuthority(gateway_harness, gateway_db)
    shadow = authority.shadow

    # Cold start: no lease yet, so the shadow abstains and registers the key.
    authority.start()
    assert shadow.report().sync_reasons == {"no_lease": 1}
    shadow.refresh_once()

    # Warm leases admit; every real reservation agrees. The seeded key has no
    # limits row, so the default 60 rpm governs: stay inside the 90% headroom.
    admitted = 40
    for _ in range(admitted):
        authority.start()
    report = shadow.report()
    assert report.verdicts.get("admit") == admitted
    assert report.agreement_rate == 1.0
    assert report.divergence_count == 0

    # Stale lease at the drain boundary: the org's credits vanish between
    # refreshes, the shadow still admits from its lease, the real gate
    # refuses. This is the bounded overspend enforcement would accept.
    authority.drain_credits()
    with pytest.raises(BudgetReservationRejected, match="insufficient_credits"):
        authority.start(maximum_cost_micro_usd=300)
    report = shadow.report()
    assert report.divergence_count == 1
    assert report.would_be_overspend_micro_usd == 300
    assert report.divergences[0].sqlstate == "P1010"

    # After the refill the shadow knows the scope is exhausted and agrees.
    shadow.refresh_once()
    with pytest.raises(BudgetReservationRejected, match="insufficient_credits"):
        authority.start()
    # An unknown worst-case price is denied locally, agreeing with P1013.
    with pytest.raises(BudgetReservationRejected, match="deployment_price_unknown"):
        authority.start(maximum_cost_micro_usd=None, priced=False)
    report = shadow.report()
    assert report.verdicts.get("deny") == 2
    assert report.agreements == admitted + 2
    assert report.divergence_count == 1
    assert report.infrastructure_errors == 0

    assert report.shadow_latency is not None
    assert report.real_latency is not None
    # The whole point: the would-be decision is orders of magnitude cheaper
    # than the synchronous reservation. Assert the direction, print the data.
    assert report.shadow_latency.p50_us < report.real_latency.p50_us
    print(f"lease-shadow integration report: {report.to_json()}")
