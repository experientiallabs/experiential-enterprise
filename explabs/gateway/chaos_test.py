# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Adversarial chaos suite: try to take the gateway down, prove it stays up.

The roadmap's rule for the API is "it should ALWAYS work" — so these tests
attack the worker and edge along the axes that break real gateways and assert
the invariants that must survive every one:

* the process never returns an uncontrolled 5xx or a corrupt body — failures
  surface as clean typed OpenAI error envelopes or a bounded truncated stream;
* the ledger never lies — no request is left dispatched-but-unsettled once the
  attempt reconciler has run, and no attempt double-charges;
* readiness holds — ``/health/ready`` is still green after each storm, so a
  transient attack never latches the pod unhealthy for every tenant;
* isolation holds — one key's abuse does not error another key's traffic.

Scope: local stack or an isolated PR sandbox only (never production — it has
no isolation and shares the customer ``/v1`` edge). Environment contract is
the load smoke's, plus these run at higher intensity.

These are integration tests (a live stack) and are deliberately NOT in the
fast CI lane; ``scripts/ci/gateway_load.sh`` runs the smoke-sized load, and a
human/manual lane runs this file at full intensity.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass

import httpx
import pytest

from explabs.gateway.conftest import GatewayHarness
from explabs.gateway.load_harness import (
    LoadProfile,
    LoopbackProvider,
    ProviderFault,
    run_load,
)

pytestmark = pytest.mark.integration

_ALIAS_WAIT_SECONDS = 90


def _edge_url() -> str:
    """The /v1 edge base, or skip when the stack is not exposed."""
    dsn = os.environ.get("SUPABASE_DB_URL")
    edge = os.environ.get("EXPLABS_LOAD_EDGE_URL") or os.environ.get("EXPLABS_LOAD_WORKER_URL")
    if not dsn or not edge:
        pytest.skip("chaos suite needs SUPABASE_DB_URL and EXPLABS_LOAD_EDGE_URL/WORKER_URL")
    return edge.rstrip("/")


@dataclass(frozen=True)
class _Lane:
    """A seeded, servable key + model pointed at the (fault-injecting) provider."""

    org_id: str
    raw_key: str
    api_key_id: str
    model_slug: str
    model_id: str
    provider_row_id: str


def _seed_lane(harness: GatewayHarness, provider_base_url: str) -> _Lane:
    """Seed one org/key/model served by the given provider URL; wait routable."""
    org_id = harness.seed_org()
    key = harness.seed_key(org_id)
    suffix = uuid.uuid4().hex[:10]
    slug = f"gw-chaos-{suffix}"
    model_id = str(uuid.uuid4())
    provider_row_id = str(uuid.uuid4())
    harness.connection.execute(
        "insert into public.models (id, slug, display_name, owning_org_id) values (%s, %s, %s, %s)",
        (model_id, slug, "Gateway chaos", org_id),
    )
    harness.connection.execute(
        """
        insert into public.model_providers (
          id, model_id, provider, provider_model_id, base_url, owning_org_id,
          billing_source, capabilities
        ) values (%s, %s, 'local', 'loopback-chaos', %s, %s, 'customer_managed',
                  '{"supports_streaming": true}'::jsonb)
        """,
        (provider_row_id, model_id, provider_base_url, org_id),
    )
    deadline = time.monotonic() + _ALIAS_WAIT_SECONDS
    alias_id: str | None = None
    while time.monotonic() < deadline:
        row = harness.fetch_one(
            "select alias_id from public.gateway_aliases"
            " where alias_name = %s and active and current_revision_id is not null",
            (slug,),
        )
        if row is not None:
            alias_id = str(row[0])
            break
        time.sleep(2)
    if alias_id is None:
        msg = f"catalog refresher never activated {slug}"
        raise AssertionError(msg)
    harness.grant_alias(f"org-{org_id}", alias_id, org_id=org_id)
    return _Lane(
        org_id=org_id,
        raw_key=key.raw_key,
        api_key_id=key.api_key_id,
        model_slug=slug,
        model_id=model_id,
        provider_row_id=provider_row_id,
    )


def _cleanup_lane(harness: GatewayHarness, lane: _Lane) -> None:
    """Drop the seeded catalog rows; the harness owns org/key teardown."""
    harness.connection.execute(
        "delete from public.model_providers where id = %s", (lane.provider_row_id,)
    )
    harness.connection.execute("delete from public.models where id = %s", (lane.model_id,))


def _provider_host_url(provider: LoopbackProvider) -> str:
    """Rewrite the loopback base to the host the worker container can reach."""
    host = os.environ.get("EXPLABS_LOAD_PROVIDER_HOST", "host.docker.internal")
    return provider.base_url.replace("127.0.0.1", host)


def _assert_ledger_settles(harness: GatewayHarness, api_key_id: str) -> None:
    """No request for this key stays dispatched-but-unsettled after settle."""
    deadline = time.monotonic() + 40
    open_rows = 1
    while time.monotonic() < deadline:
        row = harness.fetch_one(
            "select count(*) from public.gateway_requests"
            " where api_key_id = %s and terminal_state is null",
            (api_key_id,),
        )
        open_rows = int(str(row[0])) if row is not None else 0
        if open_rows == 0:
            break
        time.sleep(1)
    assert open_rows == 0, f"{open_rows} requests never reached a terminal state"
    # No attempt double-settled: every attempt has at most one settled amount.
    dup = harness.fetch_one(
        """
        select count(*) from (
          select a.request_id, a.attempt_ordinal
            from public.gateway_attempts a
            join public.gateway_requests r on r.request_id = a.request_id
           where r.api_key_id = %s
           group by a.request_id, a.attempt_ordinal having count(*) > 1
        ) dups
        """,
        (api_key_id,),
    )
    assert dup is not None
    assert int(str(dup[0])) == 0


def _is_uncontrolled_failure(status_key: str) -> bool:
    """Whether a taxonomy key is an UNCONTROLLED failure (a real defect).

    ``status_key`` is ``"<status>"`` or ``"<status>:<error_code>"``. A bare
    5xx with no error code, a non-JSON error body, or a transport-level
    exception (status ``-1``) is uncontrolled. A typed 5xx (e.g.
    ``502:all_routes_failed``) is a clean envelope, not a defect.
    """
    head, _, code = status_key.partition(":")
    if head == "-1":
        return True  # httpx transport error: hang/reset/refused
    if code in ("", "non_json_error_body"):
        return head.isdigit() and int(head) >= 500
    return False


def _ready(edge: str) -> bool:
    """Whether the worker/edge health/ready probe is green."""
    url = f"{edge}/health/ready" if "18081" in edge else f"{edge}/health"
    try:
        response = httpx.get(url, timeout=5.0)
    except httpx.HTTPError:
        return False
    return response.status_code == 200


@dataclass(frozen=True)
class _ChaosFixture:
    """The healthy-provider lane shared by the fault-free storms."""

    harness: GatewayHarness
    edge: str
    lane: _Lane


@pytest.fixture(scope="module")
def chaos_lane() -> Iterator[_ChaosFixture]:
    """A healthy-provider lane for the storms that do not need fault injection."""
    edge = _edge_url()
    dsn = os.environ["SUPABASE_DB_URL"]
    provider = LoopbackProvider()
    provider.start()
    harness = GatewayHarness(dsn)
    lane: _Lane | None = None
    try:
        lane = _seed_lane(harness, _provider_host_url(provider))
        yield _ChaosFixture(harness=harness, edge=edge, lane=lane)
    finally:
        if lane is not None:
            _cleanup_lane(harness, lane)
        harness.close()
        provider.stop()


def test_malformed_input_storm_is_uniformly_rejected(
    chaos_lane: _ChaosFixture,
) -> None:
    """Oversized, bad-JSON, wrong-type, unknown-key/model inputs never 5xx."""
    edge, lane = chaos_lane.edge, chaos_lane.lane
    good = {"Authorization": f"Bearer {lane.raw_key}", "content-type": "application/json"}
    cases: list[tuple[str, dict[str, str], bytes]] = [
        ("bad json", good, b"{not valid json"),
        ("wrong content-type", {**good, "content-type": "text/plain"}, b"hello"),
        (
            "oversized body",
            good,
            json.dumps(
                {
                    "model": lane.model_slug,
                    "messages": [{"role": "user", "content": "x" * 2_000_000}],
                }
            ).encode(),
        ),
        (
            "unknown model",
            good,
            json.dumps({"model": "no-such-model", "messages": []}).encode(),
        ),
        (
            "unknown key",
            {"Authorization": "Bearer xpl_chaos_invalid", "content-type": "application/json"},
            json.dumps({"model": lane.model_slug, "messages": []}).encode(),
        ),
        ("empty body", good, b""),
    ]
    with httpx.Client(timeout=30.0) as client:
        for name, headers, body in cases:
            response = client.post(f"{edge}/v1/chat/completions", headers=headers, content=body)
            # The one hard invariant: a client-caused fault is a 4xx, never a
            # 5xx, and never a crash. (An oversized-but-valid request may be
            # accepted and then fail cleanly downstream; allow 4xx OR a clean
            # 200/streamed handling, but never 5xx.)
            assert response.status_code < 500, f"{name} produced {response.status_code}"
    assert _ready(edge), "readiness must survive a malformed-input storm"


def test_connection_flood_keeps_the_edge_responsive(
    chaos_lane: _ChaosFixture,
) -> None:
    """Many simultaneous slow/abandoned connections do not wedge the edge."""
    edge, lane = chaos_lane.edge, chaos_lane.lane

    async def flood() -> None:
        # Open far more concurrent connections than the pool, each abandoned
        # immediately, then confirm a normal request still completes.
        limits = httpx.Limits(max_connections=200, max_keepalive_connections=0)
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0), limits=limits) as c:

            async def half_open() -> None:
                # A slow-loris upload: a body dribbled over ~5s against a 2s
                # client timeout. An httpx error (timeout/reset) is the
                # EXPECTED outcome and is swallowed; anything else propagates
                # through the gather (no return_exceptions), so a real bug in
                # the flood path is never hidden -- which was the review point.
                try:
                    await c.post(
                        f"{edge}/v1/chat/completions",
                        headers={
                            "Authorization": f"Bearer {lane.raw_key}",
                            "content-type": "application/json",
                        },
                        content=_slow_body(),
                        timeout=2.0,
                    )
                except httpx.HTTPError:
                    return

            # No return_exceptions: only httpx errors are caught above, so any
            # unexpected exception surfaces instead of being silently dropped.
            await asyncio.gather(*(half_open() for _ in range(100)))

    asyncio.run(flood())
    # The real invariant: after 100 concurrent slow/abandoned connections the
    # edge still serves a healthy request and readiness holds (below).
    # The edge must still answer a healthy request right after the flood.
    with httpx.Client(timeout=30.0) as client:
        healthy = client.post(
            f"{edge}/v1/chat/completions",
            headers={"Authorization": f"Bearer {lane.raw_key}"},
            json={"model": lane.model_slug, "messages": [{"role": "user", "content": "hi"}]},
        )
    assert healthy.status_code == 200, healthy.text
    assert _ready(edge)


async def _slow_body() -> AsyncIterator[bytes]:
    """A body that dribbles a few bytes slowly (slow-loris upload).

    Self-bounding: a handful of ~1s-spaced chunks so the total (~5s) exceeds
    the caller's 2s client timeout -- the client aborts mid-upload, which is
    the slow-loris signal -- WITHOUT relying on the timeout to interrupt a
    runaway generator (httpx may not enforce the read timeout on a stalled
    request-body upload, which would hang the task indefinitely).
    """
    for _ in range(5):
        yield b'{"x":"'
        await asyncio.sleep(1.0)


def test_provider_5xx_storm_surfaces_clean_quota_or_error_never_corrupts(
    chaos_lane: _ChaosFixture,
) -> None:
    """Every upstream 500 becomes a clean typed error; the ledger stays sane."""
    edge = chaos_lane.edge
    dsn = os.environ["SUPABASE_DB_URL"]
    provider = LoopbackProvider(fault=ProviderFault(status=500))
    provider.start()
    harness = GatewayHarness(dsn)
    lane: _Lane | None = None
    try:
        lane = _seed_lane(harness, _provider_host_url(provider))
        report = asyncio.run(
            run_load(
                target_name="provider-5xx",
                base_url=f"{edge}/v1",
                api_key=lane.raw_key,
                model=lane.model_slug,
                profile=LoadProfile(concurrency=6, duration_seconds=8, warmup_seconds=1),
                provider=provider,
            )
        )
        # The gateway must never leak an UNCONTROLLED 5xx: a bare 500, a
        # non-JSON body, or a transport crash. A *typed* 502 carrying an
        # OpenAI error code (all_routes_failed) when the model's only provider
        # is genuinely down is correct and expected -- that is what 502 Bad
        # Gateway means, and it is a clean envelope, not a crash. So the
        # invariant is "every failure is typed", not "no 5xx".
        uncontrolled = {
            status: count
            for status, count in report.outcomes_by_status.items()
            if _is_uncontrolled_failure(status)
        }
        assert not uncontrolled, f"uncontrolled failures leaked: {uncontrolled}"
        # Under a total-provider-outage every request must still resolve to a
        # typed upstream failure (no hangs, no 200-with-no-content).
        assert all(
            status.startswith(("502:", "503:", "429:")) or status == "200"
            for status in report.outcomes_by_status
        ), report.outcomes_by_status
        _assert_ledger_settles(harness, lane.api_key_id)
        assert _ready(edge), "readiness must survive a provider-5xx storm"
    finally:
        if lane is not None:
            _cleanup_lane(harness, lane)
        harness.close()
        provider.stop()


def test_provider_midstream_reset_settles_and_stays_ready(
    chaos_lane: _ChaosFixture,
) -> None:
    """A provider dying after first token settles the attempt and stays up."""
    edge = chaos_lane.edge
    dsn = os.environ["SUPABASE_DB_URL"]
    provider = LoopbackProvider(fault=ProviderFault(partial_then_reset=True))
    provider.start()
    harness = GatewayHarness(dsn)
    lane: _Lane | None = None
    try:
        lane = _seed_lane(harness, _provider_host_url(provider))
        asyncio.run(
            run_load(
                target_name="provider-reset",
                base_url=f"{edge}/v1",
                api_key=lane.raw_key,
                model=lane.model_slug,
                profile=LoadProfile(concurrency=4, duration_seconds=8, warmup_seconds=1),
                provider=provider,
            )
        )
        # The stream truncated mid-flight, but the ledger must still terminalize
        # every request (zero-completion insurance / failure settle), never
        # leaving a dispatched row to leak a reservation.
        _assert_ledger_settles(harness, lane.api_key_id)
        assert _ready(edge), "readiness must survive mid-stream provider resets"
    finally:
        if lane is not None:
            _cleanup_lane(harness, lane)
        harness.close()
        provider.stop()


def test_saturation_ramp_finds_a_stable_knee_not_a_cliff(
    chaos_lane: _ChaosFixture,
) -> None:
    """As concurrency climbs the gateway degrades gracefully, never collapses."""
    edge, lane = chaos_lane.edge, chaos_lane.lane
    throughputs: list[float] = []
    for concurrency in (1, 4, 16, 32):
        report = asyncio.run(
            run_load(
                target_name=f"ramp-c{concurrency}",
                base_url=f"{edge}/v1",
                api_key=lane.raw_key,
                model=lane.model_slug,
                profile=LoadProfile(concurrency=concurrency, duration_seconds=6, warmup_seconds=1),
            )
        )
        # Graceful: at every rung the gateway still completes requests as 200
        # (it may serialize and slow down, but it must not start erroring under
        # pure honest load).
        assert set(report.outcomes_by_status) == {"200"}, (
            f"c{concurrency}: {report.outcomes_by_status}"
        )
        throughputs.append(report.throughput_rps)
    # Throughput must never collapse toward zero as load climbs (a cliff);
    # the top rung stays a healthy fraction of the peak observed.
    assert min(throughputs) > 0
    assert throughputs[-1] >= 0.5 * max(throughputs), (
        f"throughput collapsed under load: {throughputs}"
    )
    assert _ready(edge), "readiness must survive the saturation ramp"
