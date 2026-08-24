# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for durable cross-worker replay and continuation stores."""

from __future__ import annotations

import asyncio
import hashlib
import uuid

import pytest
from exp.runtime.gateway.contracts import GatewayApiSurface, GatewayMessage
from exp.runtime.openai_protocol.errors import OpenAIProtocolError
from exp.runtime.openai_protocol.state import (
    CachedResponse,
    ContinuationState,
    ProtocolNamespace,
    ReplayClaimKind,
    ReplayKey,
)

from explabs.gateway.conftest import GatewayHarness
from explabs.gateway.db import GatewayDatabase
from explabs.gateway.protocol_state import (
    PostgresContinuationStore,
    PostgresReplayLease,
    PostgresReplayStore,
)


def _namespace(harness: GatewayHarness) -> ProtocolNamespace:
    """Build one unique tenant namespace registered for teardown."""
    organization_id = f"org-{uuid.uuid4()}"
    harness.track_protocol_org(organization_id)
    return ProtocolNamespace(
        organization_id=organization_id,
        identity_id=organization_id,
        alias_revision_id=f"revision-{uuid.uuid4().hex[:12]}",
    )


def _key(
    namespace: ProtocolNamespace,
    *,
    operation: str = "op-1",
    canonical: str = "ab" * 32,
) -> ReplayKey:
    """Build one fully scoped replay key."""
    return ReplayKey(
        namespace=namespace,
        surface=GatewayApiSurface.RESPONSES,
        caller_operation_sha256=hashlib.sha256(operation.encode()).hexdigest(),
        canonical_request_sha256=canonical,
    )


def _response(body: bytes = b'{"ok": true}') -> CachedResponse:
    """Build one exact bounded response."""
    return CachedResponse(
        status_code=200,
        media_type="application/json",
        headers=(("x-request-id", "request-abc"), ("x-alias", "gwm-test")),
        body=body,
    )


def _continuation() -> ContinuationState:
    """Build one canonical two-message continuation."""
    return ContinuationState(
        episode_key=hashlib.sha256(b"episode").hexdigest(),
        messages=(
            GatewayMessage(role="user", content="hello"),
            GatewayMessage(role="assistant", content="hi there"),
        ),
    )


def _unreachable_db() -> GatewayDatabase:
    """Return a lazily opened pool that fails if any test touches the network."""
    return GatewayDatabase("postgresql://nobody@127.0.0.1:1/nowhere", min_size=1, max_size=1)


async def test_non_owner_publication_and_bad_bounds_fail_without_any_network() -> None:
    """Ownership and bound violations are rejected before the pool opens."""
    with pytest.raises(ValueError, match="replay bounds must be positive"):
        PostgresReplayStore(_unreachable_db(), lease_seconds=0)
    with pytest.raises(ValueError, match="continuation bounds must be positive"):
        PostgresContinuationStore(_unreachable_db(), retention_seconds=0)

    store = PostgresReplayStore(_unreachable_db())
    lease = PostgresReplayLease(
        store=store,
        key=_key(
            ProtocolNamespace(
                organization_id="org-local", identity_id="org-local", alias_revision_id="rev-local"
            )
        ),
        owner_token=uuid.uuid4(),
        kind=ReplayClaimKind.JOIN,
        cached=None,
    )
    with pytest.raises(OpenAIProtocolError, match="Only the original keyed request"):
        await lease.complete(_response())

    continuations = PostgresContinuationStore(_unreachable_db(), max_entry_bytes=8)
    with pytest.raises(OpenAIProtocolError, match="too large"):
        await continuations.remember(
            namespace=ProtocolNamespace(
                organization_id="org-local", identity_id="org-local", alias_revision_id="rev-local"
            ),
            response_id="resp_local",
            state=_continuation(),
        )


@pytest.mark.integration
async def test_owner_publishes_and_any_worker_replays_the_exact_response(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A published keyed result replays byte-exactly, including from a sibling store."""
    namespace = _namespace(gateway_harness)
    key = _key(namespace)
    store = PostgresReplayStore(gateway_db)

    owner = await store.claim(key)
    assert owner.kind is ReplayClaimKind.OWNER
    await owner.complete(_response())

    # A separate store instance models a different worker sharing the database.
    sibling = PostgresReplayStore(gateway_db)
    replay = await sibling.claim(key)
    assert replay.kind is ReplayClaimKind.REPLAY
    cached = await replay.result()
    assert cached == _response()


@pytest.mark.integration
async def test_reusing_an_operation_with_another_body_is_a_protocol_conflict(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """One caller operation binds to exactly one canonical request body."""
    namespace = _namespace(gateway_harness)
    store = PostgresReplayStore(gateway_db)
    await store.claim(_key(namespace, canonical="ab" * 32))
    with pytest.raises(OpenAIProtocolError, match="different request body") as conflict:
        await store.claim(_key(namespace, canonical="cd" * 32))
    assert conflict.value.status_code == 409


@pytest.mark.integration
async def test_joiner_waits_for_the_owner_and_receives_the_published_result(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A concurrent duplicate joins in-flight work instead of re-executing."""
    namespace = _namespace(gateway_harness)
    key = _key(namespace)
    store = PostgresReplayStore(gateway_db, poll_interval_seconds=0.05)

    owner = await store.claim(key)
    joiner = await store.claim(key)
    assert joiner.kind is ReplayClaimKind.JOIN

    waiting = asyncio.create_task(joiner.result())
    await asyncio.sleep(0.1)
    assert not waiting.done()
    await owner.complete(_response())
    assert await asyncio.wait_for(waiting, timeout=5) == _response()


@pytest.mark.integration
async def test_abandoned_owner_work_fails_joiners_closed(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """No joiner ever receives invented content for abandoned work."""
    namespace = _namespace(gateway_harness)
    key = _key(namespace)
    store = PostgresReplayStore(gateway_db, poll_interval_seconds=0.05)

    owner = await store.claim(key)
    joiner = await store.claim(key)
    waiting = asyncio.create_task(joiner.result())
    await asyncio.sleep(0.1)
    await owner.abandon()
    with pytest.raises(OpenAIProtocolError, match="ended before publishing"):
        await asyncio.wait_for(waiting, timeout=5)

    # The operation is claimable again after the abandonment.
    fresh = await store.claim(key)
    assert fresh.kind is ReplayClaimKind.OWNER


@pytest.mark.integration
async def test_worker_loss_expires_ownership_within_the_lease(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A vanished owner's lease expires: joiners fail closed, new claims take over."""
    namespace = _namespace(gateway_harness)
    key = _key(namespace)
    store = PostgresReplayStore(gateway_db, lease_seconds=1, poll_interval_seconds=0.05)

    crashed_owner = await store.claim(key)
    assert crashed_owner.kind is ReplayClaimKind.OWNER
    joiner = await store.claim(key)
    waiting = asyncio.create_task(joiner.result())
    with pytest.raises(OpenAIProtocolError, match="ended before publishing"):
        await asyncio.wait_for(waiting, timeout=5)

    takeover = await store.claim(key)
    assert takeover.kind is ReplayClaimKind.OWNER
    await takeover.complete(_response())
    # The crashed owner's stale token can no longer publish over the takeover.
    with pytest.raises(OpenAIProtocolError, match="no longer belongs"):
        await crashed_owner.complete(_response(body=b'{"stale": true}'))


@pytest.mark.integration
async def test_oversized_response_is_abandoned_and_reported_unavailable(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A response above the entry cap never lands; the claim is released."""
    namespace = _namespace(gateway_harness)
    key = _key(namespace)
    store = PostgresReplayStore(gateway_db, max_entry_bytes=64)

    owner = await store.claim(key)
    with pytest.raises(OpenAIProtocolError, match="exceeds the bounded replay cache"):
        await owner.complete(_response(body=b"x" * 256))
    fresh = await store.claim(key)
    assert fresh.kind is ReplayClaimKind.OWNER


@pytest.mark.integration
async def test_continuations_round_trip_and_stay_namespace_isolated(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """Continuations resolve exactly within their namespace and fail closed outside."""
    namespace = _namespace(gateway_harness)
    store = PostgresContinuationStore(gateway_db)
    state = _continuation()
    await store.remember(namespace=namespace, response_id="resp_1", state=state)

    resolved = await store.resolve(namespace=namespace, previous_response_id="resp_1")
    assert resolved == state

    store.remember_now(namespace=namespace, response_id="resp_sync", state=state)
    assert store.resolve_now(namespace=namespace, previous_response_id="resp_sync") == state

    foreign = _namespace(gateway_harness)
    with pytest.raises(OpenAIProtocolError, match="unavailable or expired"):
        await store.resolve(namespace=foreign, previous_response_id="resp_1")
    with pytest.raises(OpenAIProtocolError, match="unavailable or expired"):
        await store.resolve(namespace=namespace, previous_response_id="resp_unknown")

    # Re-remembering the same response id replaces its state.
    longer = ContinuationState(
        episode_key=state.episode_key,
        messages=(*state.messages, GatewayMessage(role="user", content="and then?")),
    )
    await store.remember(namespace=namespace, response_id="resp_1", state=longer)
    assert await store.resolve(namespace=namespace, previous_response_id="resp_1") == longer


@pytest.mark.integration
async def test_expired_continuations_fail_closed(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """Retention is finite: an expired continuation is gone, not stale."""
    namespace = _namespace(gateway_harness)
    store = PostgresContinuationStore(gateway_db, retention_seconds=1)
    await store.remember(namespace=namespace, response_id="resp_ttl", state=_continuation())
    await asyncio.sleep(1.2)
    with pytest.raises(OpenAIProtocolError, match="unavailable or expired"):
        await store.resolve(namespace=namespace, previous_response_id="resp_ttl")
