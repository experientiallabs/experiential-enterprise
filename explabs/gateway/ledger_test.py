# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the Postgres attempt ledger over the gateway_* SQL write paths."""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from typing import cast

import pytest
from exp.common.models import ModelCapabilities
from exp.common.models.catalog import GatewayDeploymentMetadata, GatewayTokenPrices
from exp.common.models.gateway_catalog import BillingSource, ExactModelDeployment
from exp.runtime.gateway.budgets import BudgetReservationRejected, BudgetScopeKind
from exp.runtime.gateway.contracts import (
    AuthorizationSnapshot,
    DirectTarget,
    ExecutionSnapshot,
    GatewayApiSurface,
    GatewayEvent,
    GatewayEventKind,
    GatewayFailure,
    GatewayFailureClass,
    GatewayMessage,
    GatewayRequest,
    GatewayUsage,
)
from exp.runtime.gateway.ledger import (
    GatewayLedgerError,
    IdempotencyConflictError,
    IdempotencyReplayUnavailableError,
)
from exp.runtime.gateway.sqlite.store import InvalidVirtualKeyError
from exp.runtime.models.providers.async_transport import ProviderDeadlineExceeded

from explabs.gateway.conftest import GatewayHarness, SeededAlias, SeededKey
from explabs.gateway.control_store import PostgresGatewayControlStore
from explabs.gateway.db import GatewayDatabase
from explabs.gateway.ledger import (
    _DEFERRED_ACCEPTS_MAX,
    _RESERVATION_SCOPES,
    PostgresAttemptLedger,
    _terminal_values,
)

_EXACT_MODEL_ID = "exact-one"


def _request(
    content: str,
    *,
    idempotency_key: str | None = None,
) -> GatewayRequest:
    """Build one bounded request whose content is never persisted."""
    return GatewayRequest(
        surface=GatewayApiSurface.CHAT_COMPLETIONS,
        messages=(GatewayMessage(role="user", content=content),),
        maximum_output_tokens=16,
        idempotency_key=idempotency_key,
    )


def _deployment(
    *,
    deployment_id: str = "dep-primary",
    billing_source: BillingSource = BillingSource.HOST_MANAGED,
    priced: bool = True,
) -> ExactModelDeployment:
    """Return one exact deployment with optional pricing."""
    prices = (
        GatewayTokenPrices(
            input_micro_usd_per_million_tokens=1_000_000,
            output_micro_usd_per_million_tokens=2_000_000,
        )
        if priced
        else GatewayTokenPrices()
    )
    return ExactModelDeployment(
        deployment_id=deployment_id,
        source_alias=deployment_id,
        exact_model_id=_EXACT_MODEL_ID,
        connection=f"connection-{deployment_id}",
        provider="openai-compatible",
        provider_model="provider-model",
        billing_source=billing_source,
        connection_sha256="b" * 64,
        capabilities_sha256="d" * 64,
        capabilities=ModelCapabilities(maximum_output_tokens=16),
        gateway=GatewayDeploymentMetadata(prices=prices, pricing_source="test"),
    )


def _snapshot(authorization: AuthorizationSnapshot, pool_id: str) -> ExecutionSnapshot:
    """Bind one authorization to the test route plan."""
    return ExecutionSnapshot(
        authorization=authorization,
        exact_model_id=_EXACT_MODEL_ID,
        pool_id=pool_id,
        deployment_ids=("dep-primary", "dep-secondary"),
    )


class _Authority:
    """One seeded org, key, alias, control store, and ledger."""

    def __init__(
        self,
        harness: GatewayHarness,
        db: GatewayDatabase,
        *,
        drained: bool = False,
    ) -> None:
        self.harness = harness
        self.org_id: str = harness.seed_org(drained=drained)
        self.key: SeededKey = harness.seed_key(self.org_id, created_by=None)
        self.alias: SeededAlias = harness.activate_alias()
        self.store = PostgresGatewayControlStore(db)
        self.ledger = PostgresAttemptLedger(db)

    def accepted(
        self, content: str, *, idempotency_key: str | None = None
    ) -> tuple[AuthorizationSnapshot, ExecutionSnapshot]:
        """Authorize and accept one unique request.

        Keyed requests persist their accept immediately; unkeyed requests
        defer it to the first reservation (the fold's hot path).
        """
        authorization = self.store.authorize_request(
            raw_key=self.key.raw_key,
            alias=self.alias.alias_name,
            request=_request(content, idempotency_key=idempotency_key),
            deadline_monotonic=time.monotonic() + 30,
        )
        self.ledger.accept_request_sync(authorization=authorization)
        return authorization, _snapshot(authorization, self.alias.pool_id)


def test_terminal_values_mirror_the_wmo_extraction_contract() -> None:
    """State, failure class, reason, and usage normalize like Experiential's ledger."""
    usage = GatewayUsage(input_tokens=10, output_tokens=5)
    completed = GatewayEvent(kind=GatewayEventKind.COMPLETED, sequence_number=9, usage=usage)
    # A clean terminal carries no failure class and no reason.
    assert _terminal_values(completed, None) == ("completed", None, None, usage)

    incomplete = GatewayEvent(kind=GatewayEventKind.INCOMPLETE, sequence_number=9, usage=usage)
    assert _terminal_values(incomplete, None) == ("incomplete", None, None, usage)

    transport = GatewayFailure(
        failure_class=GatewayFailureClass.TRANSPORT, safe_message="link died"
    )
    # The sanitized safe_message rides through as the tenant-visible reason.
    assert _terminal_values(None, transport) == ("failed", "transport", "link died", None)

    cancelled = GatewayFailure(
        failure_class=GatewayFailureClass.CANCELLED, safe_message="caller left"
    )
    assert _terminal_values(None, cancelled) == ("cancelled", "cancelled", "caller left", None)

    failed_event = GatewayEvent(
        kind=GatewayEventKind.FAILED,
        sequence_number=9,
        usage=usage,
        failure=transport,
    )
    assert _terminal_values(failed_event, None) == ("failed", "transport", "link died", usage)

    with pytest.raises(GatewayLedgerError, match="terminal event or failure"):
        _terminal_values(None, None)
    with pytest.raises(GatewayLedgerError, match="must be terminal"):
        _terminal_values(
            GatewayEvent(kind=GatewayEventKind.TEXT_DELTA, sequence_number=0, text_delta="x"),
            None,
        )


def test_reservation_sqlstates_map_to_wmo_scopes() -> None:
    """Only the deployment scope advances the waterfall; the rest stop routing."""
    assert _RESERVATION_SCOPES == {
        "P1010": BudgetScopeKind.TEAM,
        "P1011": BudgetScopeKind.IDENTITY,
        "P1012": BudgetScopeKind.IDENTITY,
        "P1013": BudgetScopeKind.DEPLOYMENT,
        "P1014": BudgetScopeKind.TEAM,
        "P1015": BudgetScopeKind.POOL,
        "P1016": BudgetScopeKind.TEAM,
        "P1017": BudgetScopeKind.IDENTITY,
        "P1018": BudgetScopeKind.POOL,
        "P1019": BudgetScopeKind.DEPLOYMENT,
        "P1022": BudgetScopeKind.IDENTITY,
        "P1023": BudgetScopeKind.IDENTITY,
        "P1024": BudgetScopeKind.POOL,
        "P1025": BudgetScopeKind.TEAM,
        "P1030": BudgetScopeKind.TEAM,
        "P1031": BudgetScopeKind.TEAM,
    }
    non_deployment = {
        state
        for state, scope in _RESERVATION_SCOPES.items()
        if scope is not BudgetScopeKind.DEPLOYMENT
    }
    assert non_deployment == {
        "P1010",
        "P1011",
        "P1012",
        "P1014",
        "P1015",
        "P1016",
        "P1017",
        "P1018",
        "P1022",
        "P1023",
        "P1024",
        "P1025",
        # Promo transitions: both stop routing (never advance to a sibling
        # rung of the same model) and 429.
        "P1030",
        "P1031",
    }


def test_mark_promo_notified_commits_the_notice_out_of_band() -> None:
    """The one-time promo notice is written via its own gateway_mark_promo_notified call.

    A P1030 refusal inside gateway_start_attempt rolls its own transaction back,
    so start_attempt commits the marker in a SEPARATE transaction. This pins that
    the separate call targets gateway_mark_promo_notified with the org uuid and
    the requested slug (a fake pool records the call; no network needed).
    """
    recorded: list[tuple[str, tuple[object, ...]]] = []

    class _Cursor:
        def execute(self, sql: str, params: tuple[object, ...]) -> None:
            recorded.append((sql, params))

    class _FakeDB:
        @contextmanager
        def atomic_call(self):  # noqa: ANN202 - test double context manager
            yield _Cursor()

    ledger = PostgresAttemptLedger(cast("GatewayDatabase", _FakeDB()))
    ledger._mark_promo_notified("org-11111111-1111-1111-1111-111111111111", "qwen3.8-27b")  # noqa: SLF001

    assert len(recorded) == 1
    sql, params = recorded[0]
    assert "gateway_mark_promo_notified" in sql
    assert params[1] == "qwen3.8-27b"


def test_start_attempt_enforces_snapshot_invariants_before_any_network() -> None:
    """Route-plan violations fail locally without touching the pool."""
    ledger = PostgresAttemptLedger(
        GatewayDatabase("postgresql://nobody@127.0.0.1:1/nowhere", min_size=1, max_size=1)
    )
    authorization = AuthorizationSnapshot(
        request_id="request-local",
        organization_id="org-3f2e4567-e89b-4d3a-8f2e-123456789abc",
        identity_id="org-3f2e4567-e89b-4d3a-8f2e-123456789abc",
        virtual_key_id="key-1e2e4567-e89b-4d3a-8f2e-123456789abc",
        alias="gwm-local",
        alias_revision_id="revision-local",
        target=DirectTarget(pool_id="pool-local"),
        surface=GatewayApiSurface.CHAT_COMPLETIONS,
        catalog_sha256="a" * 64,
        canonical_request_sha256="b" * 64,
        deadline_monotonic=1.0,
    )
    snapshot = _snapshot(authorization, "pool-local")
    with pytest.raises(GatewayLedgerError, match="absent from the execution snapshot"):
        ledger.start_attempt_sync(
            snapshot=snapshot,
            deployment=_deployment(deployment_id="dep-unplanned"),
            attempt_ordinal=0,
            route_depth=0,
        )
    with pytest.raises(GatewayLedgerError, match="nonnegative bigint"):
        ledger.start_attempt_sync(
            snapshot=snapshot,
            deployment=_deployment(),
            attempt_ordinal=0,
            route_depth=0,
            maximum_cost_micro_usd=-1,
        )
    with pytest.raises(GatewayLedgerError, match="display-safe"):
        ledger.record_route_context(
            attempt_id="attempt-local", route_reason="x" * 513, fallback_reason=None
        )


@pytest.mark.integration
def test_settlement_writes_attempt_request_usage_event_and_rollup(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """One finished request lands one consistent row in every accounting table."""
    authority = _Authority(gateway_harness, gateway_db)
    authorization, snapshot = authority.accepted("happy path")
    attempt_id = authority.ledger.start_attempt_sync(
        snapshot=snapshot,
        deployment=_deployment(),
        attempt_ordinal=0,
        route_depth=0,
        maximum_cost_micro_usd=200,
    )
    authority.ledger.record_route_context(
        attempt_id=attempt_id, route_reason="direct", fallback_reason=None
    )
    # The write rides the background writer; drain it before asserting rows.
    assert authority.ledger.flush_route_contexts()
    usage = GatewayUsage(input_tokens=100, output_tokens=10)
    authority.ledger.finish_attempt_sync(
        attempt_id=attempt_id,
        terminal_event=GatewayEvent(
            kind=GatewayEventKind.COMPLETED, sequence_number=3, usage=usage
        ),
        failure=None,
    )

    attempt = gateway_harness.fetch_one(
        """
        select state, input_tokens, output_tokens, usage_source, estimated_cost_micro_usd,
               budget_settled_micro_usd, route_reason
        from public.gateway_attempts where attempt_id = %s
        """,
        (attempt_id,),
    )
    # 100 tokens at 1 micro-USD each + 10 tokens at 2 micro-USD each.
    assert attempt == ("completed", 100, 10, "observed", 120, 120, "direct")

    request = gateway_harness.fetch_one(
        "select terminal_state from public.gateway_requests where request_id = %s",
        (authorization.request_id,),
    )
    assert request == ("completed",)

    event = gateway_harness.fetch_one(
        """
        select org_id::text, api_key_id::text, alias, provider, lane, input_tokens,
               output_tokens, cost_micro_usd, estimated_cost_micro_usd, status, attempt_count
        from public.gateway_usage_events where request_id = %s
        """,
        (authorization.request_id,),
    )
    assert event == (
        authority.org_id,
        authority.key.api_key_id,
        authority.alias.alias_name,
        "openai-compatible",
        "platform_funded",
        100,
        10,
        120,
        0,
        "completed",
        1,
    )

    # Defensive default: the pinned Experiential runtime surfaces no tool names, so the
    # worker settles with none and both the attempt carrier and the usage
    # event's tools_used stay null. This flips to a populated array once
    # Experiential surfaces tool names (see the tool-call telemetry contract).
    tools = gateway_harness.fetch_one(
        """
        select attempts.tool_names, events.tools_used
        from public.gateway_usage_events events
        join public.gateway_attempts attempts
          on attempts.request_id = events.request_id
        where events.request_id = %s
        """,
        (authorization.request_id,),
    )
    assert tools == (None, None)

    rollup = gateway_harness.fetch_one(
        """
        select requests, input_tokens, output_tokens, spend_micro_usd
        from public.gateway_usage_daily
        where org_id = %s and alias = %s
          and user_id = '00000000-0000-0000-0000-000000000000'
        """,
        (authority.org_id, authority.alias.alias_name),
    )
    assert rollup == (1, 100, 10, 120)

    billable = gateway_harness.fetch_one(
        "select billable_spend_usd::numeric from public.organizations where id = %s",
        (authority.org_id,),
    )
    assert billable is not None
    assert float(str(billable[0])) == pytest.approx(0.00012)

    # Re-settling with the same terminal state is a silent no-op.
    authority.ledger.finish_attempt_sync(
        attempt_id=attempt_id,
        terminal_event=GatewayEvent(
            kind=GatewayEventKind.COMPLETED, sequence_number=3, usage=usage
        ),
        failure=None,
    )
    with pytest.raises(GatewayLedgerError, match="another terminal state"):
        authority.ledger.finish_attempt_sync(
            attempt_id=attempt_id,
            terminal_event=None,
            failure=GatewayFailure(
                failure_class=GatewayFailureClass.TRANSPORT, safe_message="late"
            ),
        )


@pytest.mark.integration
def test_zero_completion_insurance_never_charges_failed_or_empty_output(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """Failed and zero-output platform-funded attempts settle at 0."""
    authority = _Authority(gateway_harness, gateway_db)

    _, failed_snapshot = authority.accepted("provider error")
    failed_attempt = authority.ledger.start_attempt_sync(
        snapshot=failed_snapshot,
        deployment=_deployment(),
        attempt_ordinal=0,
        route_depth=0,
        maximum_cost_micro_usd=200,
    )
    authority.ledger.finish_attempt_sync(
        attempt_id=failed_attempt,
        terminal_event=None,
        failure=GatewayFailure(
            failure_class=GatewayFailureClass.PROVIDER_INTERNAL, safe_message="upstream 500"
        ),
    )

    _, empty_snapshot = authority.accepted("empty completion")
    empty_attempt = authority.ledger.start_attempt_sync(
        snapshot=empty_snapshot,
        deployment=_deployment(),
        attempt_ordinal=0,
        route_depth=0,
        maximum_cost_micro_usd=200,
    )
    authority.ledger.finish_attempt_sync(
        attempt_id=empty_attempt,
        terminal_event=GatewayEvent(
            kind=GatewayEventKind.COMPLETED,
            sequence_number=1,
            usage=GatewayUsage(input_tokens=50, output_tokens=0),
        ),
        failure=None,
    )

    _, partial_snapshot = authority.accepted("died mid-stream")
    partial_attempt = authority.ledger.start_attempt_sync(
        snapshot=partial_snapshot,
        deployment=_deployment(),
        attempt_ordinal=0,
        route_depth=0,
        maximum_cost_micro_usd=200,
    )
    authority.ledger.finish_attempt_sync(
        attempt_id=partial_attempt,
        terminal_event=GatewayEvent(
            kind=GatewayEventKind.INCOMPLETE,
            sequence_number=4,
            usage=GatewayUsage(input_tokens=100, output_tokens=4),
        ),
        failure=None,
    )

    settlements = {
        attempt_id: gateway_harness.fetch_one(
            "select budget_settled_micro_usd from public.gateway_attempts where attempt_id = %s",
            (attempt_id,),
        )
        for attempt_id in (failed_attempt, empty_attempt, partial_attempt)
    }
    assert settlements[failed_attempt] == (0,)
    assert settlements[empty_attempt] == (0,)
    # Delivered-then-died charges only the 4 delivered output tokens.
    assert settlements[partial_attempt] == (108,)

    billable = gateway_harness.fetch_one(
        "select billable_spend_usd::numeric from public.organizations where id = %s",
        (authority.org_id,),
    )
    assert billable is not None
    assert float(str(billable[0])) == pytest.approx(0.000108)


@pytest.mark.integration
def test_finish_request_terminalizes_pre_dispatch_failures_with_zero_cost(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A request that never dispatched emits one zero-cost usage event."""
    authority = _Authority(gateway_harness, gateway_db)
    authorization, _snapshot_unused = authority.accepted("never dispatched")
    authority.ledger.finish_request_sync(
        authorization=authorization,
        failure=GatewayFailure(
            failure_class=GatewayFailureClass.INTERNAL, safe_message="route resolution failed"
        ),
    )

    event = gateway_harness.fetch_one(
        """
        select provider, lane, cost_micro_usd, status, attempt_count
        from public.gateway_usage_events where request_id = %s
        """,
        (authorization.request_id,),
    )
    assert event == (None, None, 0, "failed", 0)

    # Idempotent on the matching terminal state; conflicting states are typed.
    authority.ledger.finish_request_sync(
        authorization=authorization,
        failure=GatewayFailure(
            failure_class=GatewayFailureClass.INTERNAL, safe_message="route resolution failed"
        ),
    )
    with pytest.raises(GatewayLedgerError, match="another terminal state"):
        authority.ledger.finish_request_sync(
            authorization=authorization,
            failure=GatewayFailure(
                failure_class=GatewayFailureClass.CANCELLED, safe_message="caller left"
            ),
        )


@pytest.mark.integration
def test_accept_request_maps_idempotency_sqlstates_to_wmo_errors(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """Caller-operation reuse surfaces Experiential's 409 error classes."""
    authority = _Authority(gateway_harness, gateway_db)
    authority.accepted("keyed request", idempotency_key="op-shared")

    conflicting = authority.store.authorize_request(
        raw_key=authority.key.raw_key,
        alias=authority.alias.alias_name,
        request=_request("different content", idempotency_key="op-shared"),
        deadline_monotonic=time.monotonic() + 30,
    )
    with pytest.raises(IdempotencyConflictError, match="idempotency_conflict"):
        authority.ledger.accept_request_sync(authorization=conflicting)

    replay = authority.store.authorize_request(
        raw_key=authority.key.raw_key,
        alias=authority.alias.alias_name,
        request=_request("keyed request", idempotency_key="op-shared"),
        deadline_monotonic=time.monotonic() + 30,
    )
    with pytest.raises(IdempotencyReplayUnavailableError, match="idempotency_replay_unavailable"):
        authority.ledger.accept_request_sync(authorization=replay)


@pytest.mark.integration
def test_money_rejections_carry_the_scope_wmo_routing_needs(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """Org, key, and route rejections map to team, identity, and deployment scopes."""
    drained = _Authority(gateway_harness, gateway_db, drained=True)
    _, drained_snapshot = drained.accepted("no credits")
    with pytest.raises(BudgetReservationRejected, match="insufficient_credits") as team_error:
        drained.ledger.start_attempt_sync(
            snapshot=drained_snapshot,
            deployment=_deployment(),
            attempt_ordinal=0,
            route_depth=0,
            maximum_cost_micro_usd=100,
        )
    assert team_error.value.scope_kind is BudgetScopeKind.TEAM

    capped = _Authority(gateway_harness, gateway_db)
    capped.harness.set_key_limits(
        capped.key.api_key_id, daily_spend_cap_micro_usd=1_000, requests_per_minute=None
    )
    _, unpriced_snapshot = capped.accepted("no known price")
    with pytest.raises(
        BudgetReservationRejected, match="deployment_price_unknown"
    ) as deployment_error:
        capped.ledger.start_attempt_sync(
            snapshot=unpriced_snapshot,
            deployment=_deployment(priced=False),
            attempt_ordinal=0,
            route_depth=0,
            maximum_cost_micro_usd=None,
        )
    assert deployment_error.value.scope_kind is BudgetScopeKind.DEPLOYMENT

    _, over_cap_snapshot = capped.accepted("over the daily cap")
    with pytest.raises(BudgetReservationRejected, match="key_daily_cap") as cap_error:
        capped.ledger.start_attempt_sync(
            snapshot=over_cap_snapshot,
            deployment=_deployment(),
            attempt_ordinal=0,
            route_depth=0,
            maximum_cost_micro_usd=1_001,
        )
    assert cap_error.value.scope_kind is BudgetScopeKind.IDENTITY

    throttled = _Authority(gateway_harness, gateway_db)
    throttled.harness.set_key_limits(
        throttled.key.api_key_id, daily_spend_cap_micro_usd=None, requests_per_minute=1
    )
    # The guard counts host-lane DISPATCHES, so the first dispatch passes and
    # the second in the same minute is rejected.
    _, first_snapshot = throttled.accepted("first dispatch in the window")
    throttled.ledger.start_attempt_sync(
        snapshot=first_snapshot,
        deployment=_deployment(),
        attempt_ordinal=0,
        route_depth=0,
        maximum_cost_micro_usd=100,
    )
    _, throttled_snapshot = throttled.accepted("second dispatch in the window")
    with pytest.raises(BudgetReservationRejected, match="key_rate_limit") as rate_error:
        throttled.ledger.start_attempt_sync(
            snapshot=throttled_snapshot,
            deployment=_deployment(),
            attempt_ordinal=0,
            route_depth=0,
            maximum_cost_micro_usd=100,
        )
    assert rate_error.value.scope_kind is BudgetScopeKind.IDENTITY
    # BYOK dispatch is never counted or blocked by the guard.
    _, byok_throttled_snapshot = throttled.accepted("byok during the throttle")
    throttled.ledger.start_attempt_sync(
        snapshot=byok_throttled_snapshot,
        deployment=_deployment(billing_source=BillingSource.CUSTOMER_MANAGED),
        attempt_ordinal=0,
        route_depth=0,
        maximum_cost_micro_usd=100,
    )

    # BYOK pass-through traffic is exempt from every one of those gates.
    _, byok_snapshot = drained.accepted("byok is never blocked")
    attempt_id = drained.ledger.start_attempt_sync(
        snapshot=byok_snapshot,
        deployment=_deployment(billing_source=BillingSource.CUSTOMER_MANAGED),
        attempt_ordinal=0,
        route_depth=0,
        maximum_cost_micro_usd=100,
    )
    assert attempt_id.startswith("attempt-")


@pytest.mark.integration
def test_concurrent_key_reservations_never_exceed_the_daily_cap(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """Ten competing reservations against a 500 micro-USD cap admit exactly five.

    Ported from Experiential's ``test_concurrent_identity_reservations_never_exceed_hard_limit``:
    the organizations row lock inside ``gateway_start_attempt`` serializes the
    check-then-reserve sequence, so the cap sum always sees every committed
    reservation.
    """
    authority = _Authority(gateway_harness, gateway_db)
    authority.harness.set_key_limits(
        authority.key.api_key_id, daily_spend_cap_micro_usd=500, requests_per_minute=None
    )
    snapshots = [authority.accepted(f"concurrent-{index}")[1] for index in range(10)]

    def reserve(index: int) -> str:
        """Attempt one competing fixed-size reservation."""
        return authority.ledger.start_attempt_sync(
            snapshot=snapshots[index],
            deployment=_deployment(),
            attempt_ordinal=0,
            route_depth=0,
            maximum_cost_micro_usd=100,
        )

    accepted: list[str] = []
    rejected_scopes: list[BudgetScopeKind] = []
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(reserve, index) for index in range(10)]
        for future in futures:
            try:
                accepted.append(future.result())
            except BudgetReservationRejected as error:
                rejected_scopes.append(error.scope_kind)

    assert len(accepted) == 5
    assert rejected_scopes == [BudgetScopeKind.IDENTITY] * 5
    reserved = gateway_harness.fetch_one(
        """
        select coalesce(sum(attempts.budget_reserved_micro_usd), 0)::int8
        from public.gateway_attempts attempts
        join public.gateway_requests requests
          on requests.request_id = attempts.request_id
        where requests.api_key_id = %s and attempts.state = 'dispatched'
        """,
        (authority.key.api_key_id,),
    )
    assert reserved == (500,)


@pytest.mark.integration
def test_retried_rpcs_return_replay_receipts_without_double_reserving(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A worker retry after a lost RPC response replays receipts, never money."""
    authority = _Authority(gateway_harness, gateway_db)
    authorization, snapshot = authority.accepted("retried rpc")
    # Retried accept with identical durable content is a silent no-op.
    authority.ledger.accept_request_sync(authorization=authorization)

    first = authority.ledger.start_attempt_sync(
        snapshot=snapshot,
        deployment=_deployment(),
        attempt_ordinal=0,
        route_depth=0,
        maximum_cost_micro_usd=100,
    )
    retried = authority.ledger.start_attempt_sync(
        snapshot=snapshot,
        deployment=_deployment(),
        attempt_ordinal=0,
        route_depth=0,
        maximum_cost_micro_usd=100,
    )
    assert retried == first

    ledger_state = gateway_harness.fetch_one(
        """
        select count(*)::int8, coalesce(sum(budget_reserved_micro_usd), 0)::int8
        from public.gateway_attempts where request_id = %s
        """,
        (authorization.request_id,),
    )
    assert ledger_state == (1, 100)

    # A retried ordinal bound to a DIFFERENT dispatch is typed drift.
    with pytest.raises(GatewayLedgerError, match="bound to a different dispatch"):
        authority.ledger.start_attempt_sync(
            snapshot=snapshot,
            deployment=_deployment(deployment_id="dep-secondary"),
            attempt_ordinal=0,
            route_depth=1,
            maximum_cost_micro_usd=100,
        )


@pytest.mark.integration
def test_revoked_keys_are_rejected_at_accept_and_at_dispatch(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A key revoked after authorization cannot persist accepts or dispatch.

    A KEYED request persists its accept immediately, so revocation surfaces
    there; an unkeyed (deferred) request meets the same 42501 gate inside the
    combined reservation, which also rolls the folded accept back — no ledger
    row may survive a revoked-key reservation.
    """
    authority = _Authority(gateway_harness, gateway_db)
    deferred_authorization, accepted_snapshot = authority.accepted("revoked before dispatch")
    unaccepted_authorization = authority.store.authorize_request(
        raw_key=authority.key.raw_key,
        alias=authority.alias.alias_name,
        request=_request("revoked before accept", idempotency_key="op-revoked"),
        deadline_monotonic=time.monotonic() + 30,
    )
    gateway_harness.connection.execute(
        "update public.api_keys set revoked_at = now() where id = %s",
        (authority.key.api_key_id,),
    )

    with pytest.raises(InvalidVirtualKeyError, match="revoked or expired"):
        authority.ledger.accept_request_sync(authorization=unaccepted_authorization)
    with pytest.raises(InvalidVirtualKeyError, match="revoked or expired"):
        authority.ledger.start_attempt_sync(
            snapshot=accepted_snapshot,
            deployment=_deployment(),
            attempt_ordinal=0,
            route_depth=0,
            maximum_cost_micro_usd=100,
        )
    leaked = gateway_harness.fetch_one(
        "select count(*) from public.gateway_requests where request_id = %s",
        (deferred_authorization.request_id,),
    )
    assert leaked is not None
    assert int(str(leaked[0])) == 0


@pytest.mark.integration
def test_past_deadline_dispatch_surfaces_the_request_deadline_outcome(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A dispatch after the request deadline is the deadline outcome, not money or 500s."""
    authority = _Authority(gateway_harness, gateway_db)
    authorization = authority.store.authorize_request(
        raw_key=authority.key.raw_key,
        alias=authority.alias.alias_name,
        request=_request("expires quickly"),
        deadline_monotonic=time.monotonic() + 1,
    )
    authority.ledger.accept_request_sync(authorization=authorization)
    time.sleep(1.2)
    with pytest.raises(ProviderDeadlineExceeded, match="deadline has passed"):
        authority.ledger.start_attempt_sync(
            snapshot=_snapshot(authorization, authority.alias.pool_id),
            deployment=_deployment(),
            attempt_ordinal=0,
            route_depth=0,
            maximum_cost_micro_usd=100,
        )


@pytest.mark.integration
def test_unkeyed_accept_defers_and_folds_into_one_reservation(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """An unkeyed accept persists nothing until the reservation commits both.

    The fold's contract: after accept_request there is NO durable row (the
    authority rides in-process), and the first start_attempt lands request and
    attempt together via gateway_accept_and_start_attempt.
    """
    authority = _Authority(gateway_harness, gateway_db)
    authorization, snapshot = authority.accepted("deferred accept")

    before = gateway_harness.fetch_one(
        "select count(*) from public.gateway_requests where request_id = %s",
        (authorization.request_id,),
    )
    assert before is not None
    assert int(str(before[0])) == 0

    attempt_id = authority.ledger.start_attempt_sync(
        snapshot=snapshot,
        deployment=_deployment(),
        attempt_ordinal=0,
        route_depth=0,
        maximum_cost_micro_usd=100,
    )
    assert attempt_id.startswith("attempt-")
    persisted = gateway_harness.fetch_one(
        """
        select requests.caller_operation_sha256 is null, count(attempts.attempt_id)::int8
        from public.gateway_requests requests
        left join public.gateway_attempts attempts on attempts.request_id = requests.request_id
        where requests.request_id = %s
        group by 1
        """,
        (authorization.request_id,),
    )
    assert persisted == (True, 1)


@pytest.mark.integration
def test_deferred_rejection_rolls_back_both_writes_then_finish_lands_history(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A rejected fold leaves no row; the lazy finish still lands usage history.

    Money guard first: the combined call's budget rejection must roll back the
    folded accept too (no accepted-authority row without its reservation
    outcome). Product contract second: the quota-refused request still shows
    up in usage history via finish_request's lazy accept+finish.
    """
    drained = _Authority(gateway_harness, gateway_db, drained=True)
    authorization, snapshot = drained.accepted("quota refused fold")
    with pytest.raises(BudgetReservationRejected, match="insufficient_credits"):
        drained.ledger.start_attempt_sync(
            snapshot=snapshot,
            deployment=_deployment(),
            attempt_ordinal=0,
            route_depth=0,
            maximum_cost_micro_usd=100,
        )
    rolled_back = gateway_harness.fetch_one(
        "select count(*) from public.gateway_requests where request_id = %s",
        (authorization.request_id,),
    )
    assert rolled_back is not None
    assert int(str(rolled_back[0])) == 0

    drained.ledger.finish_request_sync(
        authorization=authorization,
        failure=GatewayFailure(
            failure_class=GatewayFailureClass.QUOTA_EXCEEDED, safe_message="insufficient credits"
        ),
    )
    event = gateway_harness.fetch_one(
        """
        select requests.terminal_state, events.cost_micro_usd, events.attempt_count
        from public.gateway_requests requests
        join public.gateway_usage_events events on events.request_id = requests.request_id
        where requests.request_id = %s
        """,
        (authorization.request_id,),
    )
    assert event == ("failed", 0, 0)


@pytest.mark.integration
def test_deferred_lazy_finish_never_latches_on_inflight_revocation(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """Revocation between authorize and the lazy finish drops the row quietly.

    finish_request is called from paths that latch worker accounting on ANY
    exception; a key revoked mid-request must not turn one tenant's action
    into a worker-health event. The observability row is dropped (same loss
    class as the approved crash window), nothing raises.
    """
    authority = _Authority(gateway_harness, gateway_db)
    authorization, _snapshot_unused = authority.accepted("revoked before lazy finish")
    gateway_harness.connection.execute(
        "update public.api_keys set revoked_at = now() where id = %s",
        (authority.key.api_key_id,),
    )
    authority.ledger.finish_request_sync(
        authorization=authorization,
        failure=GatewayFailure(
            failure_class=GatewayFailureClass.INTERNAL, safe_message="route resolution failed"
        ),
    )
    dropped = gateway_harness.fetch_one(
        "select count(*) from public.gateway_requests where request_id = %s",
        (authorization.request_id,),
    )
    assert dropped is not None
    assert int(str(dropped[0])) == 0


def test_deferred_accept_map_holds_its_hard_bound() -> None:
    """The deferral map never exceeds its cap, even with unexpired entries.

    Expired entries are pruned first; a map saturated with UNEXPIRED entries
    (a leaking engine path) evicts oldest-first so worker memory stays bounded.
    Deferral is in-process only, so the unreachable pool is never touched.
    """
    ledger = PostgresAttemptLedger(
        GatewayDatabase("postgresql://nobody@127.0.0.1:1/nowhere", min_size=1, max_size=1)
    )
    for index in range(_DEFERRED_ACCEPTS_MAX + 100):
        ledger.accept_request_sync(
            authorization=AuthorizationSnapshot(
                request_id=f"request-bound-{index}",
                organization_id="org-3f2e4567-e89b-4d3a-8f2e-123456789abc",
                identity_id="org-3f2e4567-e89b-4d3a-8f2e-123456789abc",
                virtual_key_id="key-1e2e4567-e89b-4d3a-8f2e-123456789abc",
                alias="gwm-bound",
                alias_revision_id="revision-bound",
                target=DirectTarget(pool_id="pool-bound"),
                surface=GatewayApiSurface.CHAT_COMPLETIONS,
                catalog_sha256="a" * 64,
                canonical_request_sha256="b" * 64,
                # Far-future deadline: nothing expires, so only the hard
                # oldest-first eviction can uphold the bound.
                deadline_monotonic=time.monotonic() + 3600,
            )
        )
    assert len(ledger._deferred_accepts) == _DEFERRED_ACCEPTS_MAX  # noqa: SLF001 - bound under test
    # Oldest evicted, newest retained.
    assert "request-bound-0" not in ledger._deferred_accepts  # noqa: SLF001 - bound under test
    assert f"request-bound-{_DEFERRED_ACCEPTS_MAX + 99}" in ledger._deferred_accepts  # noqa: SLF001
