# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Postgres attempt ledger: thin wrappers over the gateway_* SQL write paths."""

from __future__ import annotations

import asyncio
import logging
import queue
import threading
from datetime import datetime, timedelta
from typing import NoReturn

import psycopg
from exp.common.models.gateway_catalog import BillingSource, ExactModelDeployment
from exp.runtime.gateway.budgets import (
    MAXIMUM_MICRO_USD,
    BudgetReservationRejected,
    BudgetScopeKind,
)
from exp.runtime.gateway.contracts import (
    AttemptId,
    AuthorizationSnapshot,
    ExecutionSnapshot,
    GatewayEvent,
    GatewayEventKind,
    GatewayFailure,
    GatewayFailureClass,
    GatewayUsage,
)
from exp.runtime.gateway.interfaces import GatewayClock
from exp.runtime.gateway.ledger import (
    GatewayLedgerError,
    IdempotencyConflictError,
    IdempotencyReplayUnavailableError,
)
from exp.runtime.gateway.sqlite.store import InvalidVirtualKeyError, SystemGatewayClock
from exp.runtime.models.providers.async_transport import ProviderDeadlineExceeded

from explabs.gateway.capture import PromptCaptureBuffer, PromptCaptureWriter
from explabs.gateway.control_store import api_key_uuid, organization_uuid
from explabs.gateway.db import GatewayDatabase
from explabs.gateway.lease_shadow import LeaseKey, LeaseShadow, ShadowProbe
from explabs.gateway.lineage import RequestLineage, RequestLineageTracker

logger = logging.getLogger(__name__)

# int-P1's typed reservation SQLSTATEs mapped onto Experiential's rejection scopes:
# deployment scope advances the waterfall; every other scope stops routing and
# returns 429 insufficient_quota. P1014/P1015 are reserved for billing-owned
# caps and map ahead of their arrival. P1016-P1019 are the gw-identity P-C
# per-scope monthly budgets: each carries the exceeded budget's own scope, so a
# deployment budget advances to a sibling route while the coarser scopes stop.
_RESERVATION_SCOPES: dict[str, BudgetScopeKind] = {
    "P1010": BudgetScopeKind.TEAM,  # insufficient_credits (organization)
    "P1011": BudgetScopeKind.IDENTITY,  # key_daily_cap
    "P1012": BudgetScopeKind.IDENTITY,  # key_rate_limit
    "P1013": BudgetScopeKind.DEPLOYMENT,  # deployment_price_unknown
    "P1014": BudgetScopeKind.TEAM,  # org_daily_cap (billing-owned)
    "P1015": BudgetScopeKind.POOL,  # model_daily_cap (billing-owned)
    "P1016": BudgetScopeKind.TEAM,  # budget_team (identity-tier monthly budget)
    "P1017": BudgetScopeKind.IDENTITY,  # budget_identity
    "P1018": BudgetScopeKind.POOL,  # budget_pool
    "P1019": BudgetScopeKind.DEPLOYMENT,  # budget_deployment
    "P1022": BudgetScopeKind.IDENTITY,  # key_token_rate_limit (TPM)
    "P1023": BudgetScopeKind.IDENTITY,  # budget_key (per-key monthly budget)
    "P1024": BudgetScopeKind.POOL,  # budget_model (no sibling route escapes it)
    # org_owner_unverified: an instant-signup org that has not unlocked spending
    # (organizations.spend_unlocked_at is null) may not draw platform credits.
    # TEAM scope stops routing (no sibling route escapes it) and surfaces as the
    # uniform 429 insufficient_quota, exactly like an exhausted balance; BYOK
    # never reaches this gate.
    "P1025": BudgetScopeKind.TEAM,  # org_owner_unverified (credit spend gate)
    # Promotional-model transitions (per-(org, model) promo cap). Both are
    # TEAM scope: they STOP routing and surface as the uniform 429
    # insufficient_quota (never advance the waterfall to another rung of the
    # same model, which would only hit the same cap). BYOK never reaches them.
    # P1030 is the one-time promo->credits switch notice; start_attempt commits
    # its one-time marker out of band (see _mark_promo_notified) before mapping.
    "P1030": BudgetScopeKind.TEAM,  # promo_exhausted_notice
    "P1031": BudgetScopeKind.TEAM,  # promo_byok_only (promo spent, credits can't cover)
}
# 23505 carries int-P1's typed drift copy (a retried RPC replaying different
# content), never a raw unique violation.
_LEDGER_INVARIANT_SQLSTATES = frozenset({"P0002", "23514", "22023", "23505"})

# In-flight requests bound the first-token observation registries; the cap only
# matters when settles are lost (crash), so plain FIFO eviction is enough.
_FIRST_TOKEN_REGISTRY_CAP = 4096

# Deferred-accept map bound: far above any sane in-flight request count, it
# exists only so an unforeseen engine path that neither reserves nor finishes
# can never grow the map unbounded.
_DEFERRED_ACCEPTS_MAX = 4096


class PostgresAttemptLedger:
    """Experiential ``AttemptLedger`` over int-P1's ``gateway_*`` SQL functions.

    Money enforcement (balance gate, key caps, rate guard, zero-completion
    insurance) lives inside the SQL functions, never in this process.

    Round-trip shape: a request WITHOUT a caller operation (no Idempotency-Key
    or client request id — the hot path) defers its accept in-process and
    commits accept + reservation in ONE ``gateway_accept_and_start_attempt``
    call at first dispatch; pre-dispatch failures persist accept + finish
    lazily in one transaction so they still land in usage history. A request
    WITH a caller operation keeps the original two-call shape, because its
    idempotency probe (P1020/P1021) is an accept-time contract that must keep
    surfacing outside the executor as a typed 409.
    """

    def __init__(
        self,
        db: GatewayDatabase,
        *,
        clock: GatewayClock | None = None,
        lease_shadow: LeaseShadow | None = None,
        lineage: RequestLineageTracker | None = None,
        capture_buffer: PromptCaptureBuffer | None = None,
        capture_writer: PromptCaptureWriter | None = None,
    ) -> None:
        """Bind one pooled database and injectable clock.

        Args:
            db: Shared worker connection pool.
            clock: Injectable wall and monotonic clock.
            lease_shadow: Optional measure-only budget-lease shadow. When set,
                every host-lane reservation also records what the leased
                admission path WOULD have decided and how long both paths
                took; enforcement stays entirely with the SQL reservation.
            lineage: Shared content-free lineage handoff the control store
                fills at authorize (see explabs/gateway/lineage.py); None
                accepts every request without lineage columns.
            capture_buffer: Shared opt-in prompt-capture handoff the control
                store fills at authorize for capture-on orgs; None disables.
            capture_writer: Background writer persisting captures off the hot
                path (see explabs/gateway/capture.py); None disables.
        """
        self._db = db
        self._clock = SystemGatewayClock() if clock is None else clock
        self._lease_shadow = lease_shadow
        self._lineage = lineage
        self._capture_buffer = capture_buffer
        self._capture_writer = capture_writer
        # Deferred accepts: request_id -> (authorization, accept-time deadline).
        # Entries are removed by the first successful combined reservation or
        # by finish_request; a worker crash simply loses in-process state along
        # with the process (the approved contract change: a request that dies
        # between authorize and its first reservation leaves no ledger row).
        self._deferred_accepts: dict[str, tuple[AuthorizationSnapshot, datetime]] = {}
        self._deferred_lock = threading.Lock()
        # Route context is display-only, so its write rides a background
        # writer instead of a synchronous pre-first-token round trip; see
        # record_route_context.
        self._route_context_queue: queue.SimpleQueue[tuple[str, str | None, str | None]] = (
            queue.SimpleQueue()
        )
        self._route_context_pending = 0
        self._route_context_condition = threading.Condition()
        self._route_context_thread: threading.Thread | None = None
        self._route_context_lock = threading.Lock()
        # Seam-observed first-token times (see observe_first_token): the
        # emitted first_token_at wins at settlement; these only backfill it
        # when the serving plane omitted one. Keyed by request, resolved per
        # attempt via the reservation-time attempt -> request mapping.
        self._first_token_lock = threading.Lock()
        self._observed_first_tokens: dict[str, datetime] = {}
        self._attempt_requests: dict[str, str] = {}

    def observe_first_token(self, *, request_id: str) -> None:
        """Stamp the wall-clock time a request's first outward token was observed.

        Called by the worker's streaming seam on the first semantic event that
        flows outward, so TTFT populates for every streaming request even when
        the serving plane did not report a ``first_token_at`` of its own (the
        plane-emitted value always wins at settlement). First observation per
        request wins; repeats are no-ops.
        """
        now = self._clock.now()
        with self._first_token_lock:
            if request_id not in self._observed_first_tokens:
                self._observed_first_tokens[request_id] = now
                self._evict_first_token_overflow()

    def _evict_first_token_overflow(self) -> None:
        """Drop the oldest registry entries beyond the crash-loss bound (locked)."""
        while len(self._observed_first_tokens) > _FIRST_TOKEN_REGISTRY_CAP:
            self._observed_first_tokens.pop(next(iter(self._observed_first_tokens)))
        while len(self._attempt_requests) > _FIRST_TOKEN_REGISTRY_CAP:
            self._attempt_requests.pop(next(iter(self._attempt_requests)))

    def _resolve_first_token(
        self,
        attempt_id: AttemptId,
        emitted: datetime | None,
        *,
        finalize_request: bool,
    ) -> datetime | None:
        """Return the settling attempt's first-token time, emitted value first.

        Consumes this attempt's request mapping and, on the finalizing settle,
        the request's observation, so the registries never outlive the request.
        """
        with self._first_token_lock:
            request_id = self._attempt_requests.pop(attempt_id, None)
            observed = None if request_id is None else self._observed_first_tokens.get(request_id)
            if finalize_request and request_id is not None:
                self._observed_first_tokens.pop(request_id, None)
        return emitted if emitted is not None else observed

    async def accept_request(self, *, authorization: AuthorizationSnapshot) -> None:
        """Record accepted authority; persist now only when idempotency is in play.

        Async seam over the blocking pooled write (Experiential's ledger protocol is
        async; one ``to_thread`` hop keeps psycopg's blocking pool untouched).

        Args:
            authorization: Frozen authority and request identity.

        Raises:
            IdempotencyConflictError: The caller operation exists for another request.
            IdempotencyReplayUnavailableError: The matching operation already exists.
            GatewayLedgerError: Attribution or deadline invariants fail.
        """
        if authorization.caller_operation_sha256 is None:
            # Deferral is a locked dict insert with no I/O; skip the thread hop
            # the pooled write would need.
            self.accept_request_sync(authorization=authorization)
            return
        await asyncio.to_thread(self.accept_request_sync, authorization=authorization)

    def accept_request_sync(self, *, authorization: AuthorizationSnapshot) -> None:
        """Blocking body of :meth:`accept_request` (tests and thread callers).

        A keyed request (caller operation present) persists immediately so its
        idempotency probe runs at accept time with today's exact semantics. An
        unkeyed request defers: the authority rides in-process to the first
        reservation, where ``gateway_accept_and_start_attempt`` commits both
        writes in one round trip. The deadline is frozen HERE either way, so a
        deferred row persists the same deadline an immediate one would have.
        """
        remaining = max(0.0, authorization.deadline_monotonic - self._clock.monotonic())
        deadline_at = self._clock.now() + timedelta(seconds=remaining)
        if authorization.caller_operation_sha256 is None:
            with self._deferred_lock:
                if len(self._deferred_accepts) >= _DEFERRED_ACCEPTS_MAX:
                    # Every entry is removed by its request's own reservation or
                    # finish; this bound only guards an unforeseen engine path
                    # that does neither. Dropping expired entries loses nothing
                    # durable (their requests are past-deadline and never wrote).
                    now = self._clock.now()
                    self._deferred_accepts = {
                        request_id: entry
                        for request_id, entry in self._deferred_accepts.items()
                        if entry[1] > now
                    }
                self._deferred_accepts[authorization.request_id] = (authorization, deadline_at)
                # HARD bound: if the map is still saturated with unexpired
                # entries, evict the oldest (insertion order ~ deadline order —
                # deadlines are accept time + a fixed timeout). Reaching this
                # with 64 admitted logical requests means thousands of leaked
                # entries, so the evictees are effectively always dead; in the
                # worst case an evicted ACTIVE request fails its reservation
                # and finish (P0002, no money moved) and may latch readiness —
                # the correct loud outcome for a worker already leaking state.
                while len(self._deferred_accepts) > _DEFERRED_ACCEPTS_MAX:
                    self._deferred_accepts.pop(next(iter(self._deferred_accepts)))
            return
        # Collect the content-free lineage the control store derived while the
        # request body was in scope; absent for replays of another worker's
        # request or when lineage is disabled — the columns simply stay null.
        lineage = self._pop_lineage(authorization.request_id)
        try:
            with self._db.atomic_call() as cursor:
                cursor.execute(
                    "select public.gateway_accept_request"
                    "(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (
                        authorization.request_id,
                        organization_uuid(authorization.organization_id),
                        api_key_uuid(authorization.virtual_key_id),
                        authorization.alias,
                        authorization.alias_revision_id,
                        authorization.surface.value,
                        authorization.canonical_request_sha256,
                        authorization.caller_operation_sha256,
                        deadline_at,
                        *_lineage_values(lineage),
                    ),
                )
        except psycopg.errors.DatabaseError as error:
            # The accept failed: drop any buffered capture so content never
            # outlives the request it belonged to.
            self._drop_capture(authorization.request_id)
            _raise_mapped(error)
        self._enqueue_capture(authorization.request_id)

    def _enqueue_capture(self, request_id: str) -> None:
        """Hand a buffered capture to the background writer.

        Called only once the gateway_requests row durably exists (immediate
        accept, the deferred fold, or finish_request's lazy accept): the
        capture table foreign-keys the request, the write rides a background
        writer off the hot path, and the SQL function re-checks the org
        opt-in before persisting.
        """
        if self._capture_buffer is None or self._capture_writer is None:
            return
        captured = self._capture_buffer.pop(request_id)
        if captured is not None:
            self._capture_writer.enqueue(captured)

    def _drop_capture(self, request_id: str) -> None:
        """Forget a buffered capture whose request will never persist."""
        if self._capture_buffer is not None:
            self._capture_buffer.pop(request_id)

    def _pop_lineage(self, request_id: str) -> RequestLineage | None:
        """Collect the lineage derived at authorize, exactly once per request."""
        if self._lineage is None:
            return None
        return self._lineage.pop(request_id)

    def _peek_lineage(self, request_id: str) -> RequestLineage | None:
        """Read lineage WITHOUT consuming it.

        The deferred fold may fail on one rung (budget rejection) and retry on
        the next; peeking keeps the lineage available for that retry, and the
        entry is popped once the fold commits (start_attempt_sync) or the
        request finishes.
        """
        if self._lineage is None:
            return None
        return self._lineage.peek(request_id)

    def _execute_reservation(
        self,
        *,
        deferred: tuple[AuthorizationSnapshot, datetime] | None,
        authorization: AuthorizationSnapshot,
        attempt_params: tuple[object, ...],
    ) -> tuple[object, ...] | None:
        """Run the reservation call: folded on a deferred first rung, else plain.

        The first reservation of a deferred request persists authority and
        reserves in one round trip. A failure (budget rejection, revoked key,
        invariant) rolls BOTH back, so the deferral stays pending for the
        waterfall's next rung or for finish_request's lazy accept+finish.
        """
        with self._db.atomic_call() as cursor:
            if deferred is not None:
                _, deadline_at = deferred
                # Peek, don't pop: a refused fold (budget, revoked key) rolls
                # back and the next rung's fold must still carry the lineage.
                lineage = self._peek_lineage(authorization.request_id)
                cursor.execute(
                    """
                    select attempt_id from public.gateway_accept_and_start_attempt(
                        %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s
                    )
                    """,
                    (
                        authorization.request_id,
                        organization_uuid(authorization.organization_id),
                        api_key_uuid(authorization.virtual_key_id),
                        authorization.alias,
                        authorization.alias_revision_id,
                        authorization.surface.value,
                        authorization.canonical_request_sha256,
                        deadline_at,
                        *attempt_params,
                        *_lineage_values(lineage),
                    ),
                )
            else:
                cursor.execute(
                    """
                    select attempt_id from public.gateway_start_attempt(
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                    )
                    """,
                    (
                        authorization.request_id,
                        organization_uuid(authorization.organization_id),
                        *attempt_params,
                    ),
                )
            return cursor.fetchone()

    def _begin_lease_probe(
        self,
        *,
        snapshot: ExecutionSnapshot,
        deployment: ExactModelDeployment,
        maximum_cost_micro_usd: int | None,
    ) -> ShadowProbe | None:
        """Open the measure-only lease probe for one host-lane reservation.

        The probe times the enforcing SQL reservation — the plain call, or
        the folded accept+reserve on a deferred request's first rung — and
        compares it with the would-be in-memory lease decision, exactly once
        per reservation either way. begin() never raises and the
        reservation's behavior is untouched. The id parsers in the key cannot
        raise here: the control store minted these artifact ids, and the same
        parsers run in the SQL parameter tuples the caller binds.
        """
        if (
            self._lease_shadow is None
            or deployment.billing_source is not BillingSource.HOST_MANAGED
        ):
            return None
        authorization = snapshot.authorization
        return self._lease_shadow.begin(
            LeaseKey(
                org_id=str(organization_uuid(authorization.organization_id)),
                api_key_id=str(api_key_uuid(authorization.virtual_key_id)),
                alias=authorization.alias,
                provider=deployment.provider,
                exact_model_id=snapshot.exact_model_id,
            ),
            maximum_cost_micro_usd,
        )

    def _deferred_accept(self, request_id: str) -> tuple[AuthorizationSnapshot, datetime] | None:
        """Return the pending deferred accept for one request, if any."""
        with self._deferred_lock:
            return self._deferred_accepts.get(request_id)

    def _resolve_deferred_accept(self, request_id: str) -> None:
        """Drop one deferred accept after its authority is durably persisted."""
        with self._deferred_lock:
            self._deferred_accepts.pop(request_id, None)

    async def start_attempt(
        self,
        *,
        snapshot: ExecutionSnapshot,
        deployment: ExactModelDeployment,
        attempt_ordinal: int,
        route_depth: int,
        maximum_cost_micro_usd: int | None = None,
        route_reason: str | None = None,
        fallback_reason: str | None = None,
    ) -> AttemptId:
        """Atomically reserve cost and persist one attempt before dispatch.

        The worst-case cost is computed by Experiential's executor
        (``maximum_attempt_cost_micro_usd``) and arrives here as a parameter;
        ``gateway_start_attempt`` enforces every applicable money limit before
        the reservation commits. Route context rides this call (Experiential's
        protocol dropped the separate ``record_route_context`` seam) but keeps
        its display-only background write off the pre-first-token hot path.

        Args:
            snapshot: Route-bound immutable request plan.
            deployment: Exact deployment about to receive the request.
            attempt_ordinal: Zero-based physical dispatch position.
            route_depth: Zero-based operational route position.
            maximum_cost_micro_usd: Conservative charge reserved before dispatch.
            route_reason: Optional learned-selection reason code.
            fallback_reason: Optional embedding or router fallback reason code.

        Returns:
            Stable new attempt ID.

        Raises:
            BudgetReservationRejected: A money limit blocks this route or key.
            GatewayLedgerError: Snapshot or request invariants fail.
        """
        attempt_id = await asyncio.to_thread(
            self.start_attempt_sync,
            snapshot=snapshot,
            deployment=deployment,
            attempt_ordinal=attempt_ordinal,
            route_depth=route_depth,
            maximum_cost_micro_usd=maximum_cost_micro_usd,
        )
        # Remember which request this attempt serves so a settle that arrives
        # without a plane-emitted first_token_at can use the seam observation.
        with self._first_token_lock:
            self._attempt_requests[attempt_id] = snapshot.authorization.request_id
            self._evict_first_token_overflow()
        if route_reason is not None or fallback_reason is not None:
            self.record_route_context(
                attempt_id=attempt_id,
                route_reason=route_reason,
                fallback_reason=fallback_reason,
            )
        return attempt_id

    def start_attempt_sync(
        self,
        *,
        snapshot: ExecutionSnapshot,
        deployment: ExactModelDeployment,
        attempt_ordinal: int,
        route_depth: int,
        maximum_cost_micro_usd: int | None = None,
    ) -> AttemptId:
        """Blocking body of :meth:`start_attempt` (tests and thread callers)."""
        if deployment.deployment_id not in snapshot.deployment_ids:
            message = "attempt deployment is absent from the execution snapshot"
            raise GatewayLedgerError(message)
        if deployment.exact_model_id != snapshot.exact_model_id:
            message = "attempt deployment changes the selected exact model"
            raise GatewayLedgerError(message)
        if maximum_cost_micro_usd is not None and not (
            0 <= maximum_cost_micro_usd <= MAXIMUM_MICRO_USD
        ):
            message = "maximum attempt cost must fit a nonnegative bigint"
            raise GatewayLedgerError(message)
        prices = deployment.gateway.prices
        authorization = snapshot.authorization
        probe = self._begin_lease_probe(
            snapshot=snapshot,
            deployment=deployment,
            maximum_cost_micro_usd=maximum_cost_micro_usd,
        )
        attempt_params = (
            attempt_ordinal,
            route_depth,
            deployment.deployment_id,
            deployment.provider,
            snapshot.exact_model_id,
            snapshot.pool_id,
            authorization.catalog_sha256,
            deployment.billing_source.value,
            deployment.gateway.pricing_source,
            deployment.gateway.pricing_effective_at,
            prices.input_micro_usd_per_million_tokens,
            prices.cached_input_micro_usd_per_million_tokens,
            prices.output_micro_usd_per_million_tokens,
            prices.reasoning_micro_usd_per_million_tokens,
            maximum_cost_micro_usd,
        )
        deferred = self._deferred_accept(authorization.request_id)
        try:
            row = self._execute_reservation(
                deferred=deferred, authorization=authorization, attempt_params=attempt_params
            )
        except psycopg.errors.DatabaseError as error:
            if probe is not None:
                probe.settle_refused(error.sqlstate)
            if error.sqlstate == "P1030":
                # The promo->credits transition refusal raised inside
                # gateway_start_attempt and rolled its own transaction back, so
                # the one-time notice marker cannot be written there. Commit it
                # HERE in a fresh transaction; the customer's retry then falls
                # through to the credits path instead of refusing again. The
                # refusal's DETAIL carries the promotion id (scoped promotions
                # can span models and lanes, so the alias alone no longer
                # names the promotion).
                self._mark_promo_notified(
                    authorization.organization_id,
                    (error.diag.message_detail or "").strip(),
                )
            _raise_mapped(error)
        if probe is not None:
            probe.settle_admitted()
        if deferred is not None:
            self._resolve_deferred_accept(authorization.request_id)
            # The fold durably persisted the accept (lineage included);
            # release the in-process entry and ship any buffered capture.
            self._pop_lineage(authorization.request_id)
            self._enqueue_capture(authorization.request_id)
        if row is None:
            message = "gateway attempt reservation returned no attempt ID"
            raise GatewayLedgerError(message)
        return str(row[0])

    def _mark_promo_notified(self, organization_id: str, promotion_id: str) -> None:
        """Commit the one-time promo-exhaustion notice marker out of band.

        The refusing ``gateway_start_attempt`` call raises P1030 and rolls its
        own work back, so the marker must be written in a separate transaction.
        Best-effort: if it fails the notice simply repeats on the next request
        rather than corrupting accounting, so the failure is logged and dropped.

        Args:
            organization_id: Owning organization of the refused request.
            promotion_id: The exhausted promotion, from the refusal's DETAIL.
                Empty (a malformed refusal) is logged and dropped the same way.
        """
        if not promotion_id:
            logger.warning("P1030 refusal carried no promotion id detail; the notice may repeat")
            return
        try:
            with self._db.atomic_call() as cursor:
                cursor.execute(
                    "select public.gateway_mark_promo_notified(%s, %s::uuid)",
                    (organization_uuid(organization_id), promotion_id),
                )
        except psycopg.errors.DatabaseError:
            logger.warning(
                "promo exhaustion notice marker write failed; the notice may repeat",
                exc_info=True,
            )

    async def finish_attempt(
        self,
        *,
        attempt_id: AttemptId,
        terminal_event: GatewayEvent | None,
        failure: GatewayFailure | None,
        finalize_request: bool = True,
        first_token_at: datetime | None = None,
    ) -> None:
        """Idempotently settle one attempt with normalized content-free fields.

        Args:
            attempt_id: Stable attempt ID.
            terminal_event: Provider terminal event, possibly carrying usage.
            failure: Sanitized failure when no successful terminal event exists.
            finalize_request: Whether this attempt is the final route for its
                parent request; finalizing emits the canonical usage event and
                daily rollup inside the same settlement transaction.
            first_token_at: Wall-clock time this attempt streamed its first
                token, ``None`` when it never produced one.

        Raises:
            GatewayLedgerError: The attempt is unknown or already settled
                with another terminal state.
        """
        await asyncio.to_thread(
            self.finish_attempt_sync,
            attempt_id=attempt_id,
            terminal_event=terminal_event,
            failure=failure,
            finalize_request=finalize_request,
            # The plane-emitted first-token time wins; the seam observation
            # (observe_first_token) backfills it when the plane omitted one.
            first_token_at=self._resolve_first_token(
                attempt_id, first_token_at, finalize_request=finalize_request
            ),
        )

    def finish_attempt_sync(
        self,
        *,
        attempt_id: AttemptId,
        terminal_event: GatewayEvent | None,
        failure: GatewayFailure | None,
        finalize_request: bool = True,
        first_token_at: datetime | None = None,
    ) -> None:
        """Blocking body of :meth:`finish_attempt` (tests and thread callers)."""
        state, failure_class, error_message, usage = _terminal_values(terminal_event, failure)
        try:
            with self._db.atomic_call() as cursor:
                cursor.execute(
                    "select public.gateway_settle_attempt("
                    "%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (
                        attempt_id,
                        state,
                        failure_class,
                        None if usage is None else usage.input_tokens,
                        None if usage is None else usage.cached_input_tokens,
                        None if usage is None else usage.output_tokens,
                        None if usage is None else usage.reasoning_tokens,
                        "unknown" if usage is None else "observed",
                        finalize_request,
                        # Tool names for the usage ledger's tools_used column,
                        # names only. Defensively None: the pinned Experiential
                        # GatewayUsage carries no tool names yet, so the column
                        # stays null until Experiential surfaces them (see the tool-call
                        # telemetry contract). The moment GatewayUsage gains a
                        # tool_names field, this becomes
                        # `None if usage is None else list(usage.tool_names)`.
                        None,
                        # Experiential's sanitized human-readable failure reason, so a
                        # non-OK request can show WHY it failed. None on success.
                        error_message,
                        # Winning attempt's first streamed token wall-clock time;
                        # gateway_finalize_usage derives ttft_ms from it.
                        first_token_at,
                    ),
                )
        except psycopg.errors.DatabaseError as error:
            _raise_mapped(error)

    async def finish_request(
        self,
        *,
        authorization: AuthorizationSnapshot,
        failure: GatewayFailure,
    ) -> None:
        """Idempotently terminalize accepted work that never reached dispatch.

        Args:
            authorization: Frozen authority identifying the accepted request.
            failure: Sanitized pre-dispatch terminal failure.

        Raises:
            GatewayLedgerError: The request is unknown, belongs to another
                organization, or already settled with another terminal state.
        """
        await asyncio.to_thread(
            self.finish_request_sync,
            authorization=authorization,
            failure=failure,
        )

    def finish_request_sync(
        self,
        *,
        authorization: AuthorizationSnapshot,
        failure: GatewayFailure,
    ) -> None:
        """Blocking body of :meth:`finish_request` (tests and thread callers)."""
        state, failure_class, error_message, _usage = _terminal_values(None, failure)
        finish_params = (
            authorization.request_id,
            organization_uuid(authorization.organization_id),
            state,
            # Pre-dispatch outcome reason: stored on the request so
            # the usage event can surface it even with no attempt.
            failure_class,
            error_message,
        )
        deferred = self._deferred_accept(authorization.request_id)
        if deferred is not None:
            # A deferred request that never reserved has no durable row yet:
            # persist accept + finish atomically so the pre-dispatch failure
            # still lands in usage history. Cold path — a genuine transaction
            # is fine here.
            _, deadline_at = deferred
            lineage = self._pop_lineage(authorization.request_id)
            try:
                with self._db.transaction() as cursor:
                    cursor.execute(
                        "select public.gateway_accept_request"
                        "(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                        (
                            authorization.request_id,
                            organization_uuid(authorization.organization_id),
                            api_key_uuid(authorization.virtual_key_id),
                            authorization.alias,
                            authorization.alias_revision_id,
                            authorization.surface.value,
                            authorization.canonical_request_sha256,
                            None,
                            deadline_at,
                            *_lineage_values(lineage),
                        ),
                    )
                    cursor.execute(
                        "select public.gateway_finish_request(%s, %s, %s, %s, %s)",
                        finish_params,
                    )
            except psycopg.errors.DatabaseError as error:
                diagnostic = error.diag.message_primary or str(error)
                if (error.sqlstate or "") == "42501" and "requires service role" not in diagnostic:
                    # The key was revoked between authorize and this lazy write.
                    # The request never dispatched and never charged; dropping
                    # its observability row is the same approved loss class as
                    # the crash window, and must not latch worker accounting.
                    # (The service-role variant is infrastructure and re-raises
                    # through the mapping like every other unexpected state.)
                    self._resolve_deferred_accept(authorization.request_id)
                    self._drop_capture(authorization.request_id)
                    logger.warning(
                        "dropping lazy accept+finish for %s: key authority revoked in flight",
                        authorization.request_id,
                    )
                    return
                self._drop_capture(authorization.request_id)
                _raise_mapped(error)
            self._resolve_deferred_accept(authorization.request_id)
            self._enqueue_capture(authorization.request_id)
            return
        try:
            with self._db.atomic_call() as cursor:
                cursor.execute(
                    "select public.gateway_finish_request(%s, %s, %s, %s, %s)",
                    finish_params,
                )
        except psycopg.errors.DatabaseError as error:
            _raise_mapped(error)

    def record_route_context(
        self,
        *,
        attempt_id: AttemptId,
        route_reason: str | None,
        fallback_reason: str | None,
    ) -> None:
        """Attach display-safe learned-route context without request content.

        Args:
            attempt_id: Stable dispatched attempt ID.
            route_reason: Optional learned-selection reason code.
            fallback_reason: Optional embedding or router fallback reason code.

        Raises:
            GatewayLedgerError: A value is not display-safe or the attempt is
                not currently dispatched.
        """
        for value in (route_reason, fallback_reason):
            if value is not None and (len(value) > 512 or any(ord(char) < 32 for char in value)):
                message = "route context must be a short display-safe code"
                raise GatewayLedgerError(message)
        # Display-only strings must not cost the hot path a round trip: WMO
        # calls this between reservation and dispatch, squarely inside the
        # pre-first-token window. Enqueue for the background writer; a lost
        # write degrades two nullable UI columns, never accounting, so writer
        # failures are logged and dropped rather than surfaced to routing.
        self._ensure_route_context_writer()
        with self._route_context_condition:
            self._route_context_pending += 1
        self._route_context_queue.put((attempt_id, route_reason, fallback_reason))

    def _ensure_route_context_writer(self) -> None:
        """Start the single background route-context writer once."""
        if self._route_context_thread is not None:
            return
        with self._route_context_lock:
            if self._route_context_thread is not None:
                return
            thread = threading.Thread(
                target=self._drain_route_contexts,
                name="gateway-route-context-writer",
                daemon=True,
            )
            self._route_context_thread = thread
            thread.start()

    def _drain_route_contexts(self) -> None:
        """Write queued route contexts until process exit (daemon thread)."""
        while True:
            attempt_id, route_reason, fallback_reason = self._route_context_queue.get()
            try:
                with self._db.atomic_call() as cursor:
                    cursor.execute(
                        "select public.gateway_record_route_context(%s, %s, %s)",
                        (attempt_id, route_reason, fallback_reason),
                    )
            except psycopg.errors.DatabaseError:
                logger.warning(
                    "route context write dropped for attempt %s", attempt_id, exc_info=True
                )
            finally:
                with self._route_context_condition:
                    self._route_context_pending -= 1
                    self._route_context_condition.notify_all()

    def flush_route_contexts(self, timeout_seconds: float = 10.0) -> bool:
        """Block until every enqueued route context is written (tests/drain).

        Returns:
            True when the queue drained inside the timeout.
        """
        deadline = self._clock.monotonic() + timeout_seconds
        with self._route_context_condition:
            while self._route_context_pending > 0:
                remaining = deadline - self._clock.monotonic()
                if remaining <= 0:
                    return False
                self._route_context_condition.wait(timeout=remaining)
        return True


def _lineage_values(
    lineage: RequestLineage | None,
) -> tuple[str | None, str | None, int | None]:
    """The three lineage SQL parameters, nulls when no lineage was derived."""
    if lineage is None:
        return (None, None, None)
    return (lineage.prompt_sha256, lineage.conversation_sha256, lineage.stable_prefix_chars)


def _terminal_values(
    terminal_event: GatewayEvent | None,
    failure: GatewayFailure | None,
) -> tuple[str, str | None, str | None, GatewayUsage | None]:
    """Normalize one finish call to state, failure class, reason, and usage.

    Returns ``(state, failure_class, error_message, usage)``. ``failure_class``
    and ``error_message`` (Experiential's sanitized ``safe_message``) are the tenant's
    outcome reason on a failure/cancellation, ``None`` on a clean terminal.
    Mirrors Experiential's SQLite ledger extraction contract exactly so both stores
    settle identical terminal rows for identical streams.
    """
    event_failure = None if terminal_event is None else terminal_event.failure
    normalized = failure or event_failure
    if terminal_event is None and normalized is None:
        message = "attempt finish needs a terminal event or failure"
        raise GatewayLedgerError(message)
    if terminal_event is not None and terminal_event.kind not in {
        GatewayEventKind.COMPLETED,
        GatewayEventKind.INCOMPLETE,
        GatewayEventKind.FAILED,
    }:
        message = "attempt finish event must be terminal"
        raise GatewayLedgerError(message)
    if normalized is not None:
        state = (
            "cancelled" if normalized.failure_class == GatewayFailureClass.CANCELLED else "failed"
        )
        return (
            state,
            normalized.failure_class.value,
            normalized.safe_message,
            (None if terminal_event is None else terminal_event.usage),
        )
    if terminal_event is None:  # pragma: no cover - unreachable by the branch above
        message = "attempt finish needs a terminal event or failure"
        raise GatewayLedgerError(message)
    return terminal_event.kind.value, None, None, terminal_event.usage


def _raise_mapped(error: psycopg.errors.DatabaseError) -> NoReturn:
    """Translate one typed SQL failure into its Experiential gateway exception.

    Unknown states (connection loss, programming errors) re-raise untouched so
    Experiential's accounting-failure latch sees infrastructure failures as such.
    """
    sqlstate = error.sqlstate or ""
    diagnostic = error.diag.message_primary
    message = str(error) if diagnostic is None else diagnostic
    scope = _RESERVATION_SCOPES.get(sqlstate)
    if scope is not None:
        raise BudgetReservationRejected(scope_kind=scope, reason=message) from error
    if sqlstate == "23514" and "deadline has passed" in message:
        # int-P1 refuses dispatch past the request deadline; surface Experiential's
        # deadline exception so the caller gets the request-deadline outcome
        # (timeout), never a waterfall advance, a quota 429, or the
        # accounting-unhealthy latch.
        raise ProviderDeadlineExceeded(message) from error
    if sqlstate == "42501" and "requires service role" not in message:
        # int-P1 gates revoked/expired keys at accept AND dispatch; surface
        # Experiential auth exception so the HTTP mapping stays a uniform 401. The
        # service-role gate itself is an infrastructure misconfiguration and
        # re-raises untouched.
        raise InvalidVirtualKeyError(message) from error
    if sqlstate == "P1020":
        raise IdempotencyConflictError(message) from error
    if sqlstate == "P1021":
        raise IdempotencyReplayUnavailableError(message) from error
    if sqlstate in _LEDGER_INVARIANT_SQLSTATES:
        raise GatewayLedgerError(message) from error
    raise error
