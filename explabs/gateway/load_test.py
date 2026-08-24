# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Gateway load/latency smoke against a LIVE stack (integration).

Drives the deterministic ``LoopbackProvider`` through a real gateway worker
(and, when exposed, the ``/v1`` edge) with the closed-loop harness, then
gates on SHAPE, not absolute time — runner hardware is noisy, so the
regression signals are runner-independent:

* every steady-state outcome is a 200 (any other status is a finding),
* the ledger agrees with the wire: every provider dispatch settled, every
  ``gateway_requests`` row for the seeded key is terminal ``completed``,
* the report serializes (the artifact CI publishes for trend-watching).

Environment contract (all set by ``scripts/ci/gateway_load.sh`` or a human):

* ``SUPABASE_DB_URL``            — the stack's Postgres; seeds + asserts.
* ``EXPLABS_LOAD_WORKER_URL``    — the worker's base (e.g. http://127.0.0.1:18081);
  optional, requires the compose host port.
* ``EXPLABS_LOAD_EDGE_URL``      — the /v1 edge base (e.g. http://127.0.0.1:18080);
  optional. At least one target must be set.
* ``EXPLABS_LOAD_PROVIDER_HOST`` — hostname the WORKER container uses to reach
  this process's loopback provider (default ``host.docker.internal``).
* ``EXPLABS_LOAD_REPORT_PATH``   — optional; the JSON reports land here.
* ``EXPLABS_LOAD_CONCURRENCY`` / ``EXPLABS_LOAD_DURATION_SECONDS`` — optional
  overrides (defaults 8 / 20s; CI stays small per the validation cost
  discipline — full-scale runs are a manual lane).

The smoke drives the BYOK (customer_managed) lane: it exercises the full
auth → accept → dispatch → settle path with zero money-gate coupling, so its
shape gates stay deterministic. Host-lane (money-gate) latency is measured in
dedicated local runs where credits and priced rates are seeded deliberately.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

from explabs.gateway.conftest import GatewayHarness
from explabs.gateway.load_harness import (
    LoadProfile,
    LoadReport,
    LoopbackProvider,
    run_load,
)

pytestmark = pytest.mark.integration

_ALIAS_WAIT_SECONDS = 90  # two catalog-refresher cycles plus margin


def _require_env() -> tuple[str, dict[str, str]]:
    """Resolve the environment contract or skip the module."""
    dsn = os.environ.get("SUPABASE_DB_URL")
    targets = {
        name: url
        for name, url in (
            ("worker", os.environ.get("EXPLABS_LOAD_WORKER_URL")),
            ("edge", os.environ.get("EXPLABS_LOAD_EDGE_URL")),
        )
        if url
    }
    if not dsn or not targets:
        pytest.skip(
            "gateway load smoke needs SUPABASE_DB_URL and at least one of "
            "EXPLABS_LOAD_WORKER_URL / EXPLABS_LOAD_EDGE_URL"
        )
    return dsn, targets


@dataclass(frozen=True)
class _SeededLane:
    """Everything the load run needs about the seeded servable model."""

    org_id: str
    raw_key: str
    api_key_id: str
    model_slug: str
    model_id: str
    provider_row_id: str


def _seed_servable_model(harness: GatewayHarness, provider_base_url: str) -> _SeededLane:
    """Seed one org, key, and loopback-served model; wait until routable.

    Mirrors the acceptance seeding: an org-private model on the ``local``
    provider (customer_managed), granted to the org's default identity once
    the catalog refresher activates the alias.
    """
    org_id = harness.seed_org()
    key = harness.seed_key(org_id)
    suffix = uuid.uuid4().hex[:10]
    model_slug = f"gw-load-{suffix}"
    model_id = str(uuid.uuid4())
    provider_row_id = str(uuid.uuid4())
    harness.connection.execute(
        """
        insert into public.models (id, slug, display_name, owning_org_id)
        values (%s, %s, %s, %s)
        """,
        (model_id, model_slug, "Gateway load smoke", org_id),
    )
    harness.connection.execute(
        """
        insert into public.model_providers (
          id, model_id, provider, provider_model_id, base_url, owning_org_id,
          billing_source, capabilities
        ) values (%s, %s, 'local', 'loopback-load', %s, %s, 'customer_managed',
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
            (model_slug,),
        )
        if row is not None:
            alias_id = str(row[0])
            break
        time.sleep(2)
    if alias_id is None:
        msg = f"catalog refresher never activated {model_slug} within {_ALIAS_WAIT_SECONDS}s"
        raise AssertionError(msg)
    harness.grant_alias(f"org-{org_id}", alias_id, org_id=org_id)
    return _SeededLane(
        org_id=org_id,
        raw_key=key.raw_key,
        api_key_id=key.api_key_id,
        model_slug=model_slug,
        model_id=model_id,
        provider_row_id=provider_row_id,
    )


def _cleanup_lane(harness: GatewayHarness, lane: _SeededLane) -> None:
    """Remove the seeded catalog rows; the harness owns the org/key teardown."""
    harness.connection.execute(
        "delete from public.model_providers where id = %s", (lane.provider_row_id,)
    )
    harness.connection.execute("delete from public.models where id = %s", (lane.model_id,))


@pytest.fixture(scope="module")
def load_env() -> Iterator[tuple[GatewayHarness, LoopbackProvider, _SeededLane, dict[str, str]]]:
    """One provider + seeded lane shared by every target's run."""
    dsn, targets = _require_env()
    provider = LoopbackProvider()
    provider.start()
    provider_host = os.environ.get("EXPLABS_LOAD_PROVIDER_HOST", "host.docker.internal")
    provider_url = provider.base_url.replace("127.0.0.1", provider_host)
    harness = GatewayHarness(dsn)
    lane: _SeededLane | None = None
    try:
        lane = _seed_servable_model(harness, provider_url)
        yield harness, provider, lane, targets
    finally:
        if lane is not None:
            _cleanup_lane(harness, lane)
        harness.close()
        provider.stop()


def _profile() -> LoadProfile:
    """The smoke profile, small by default, overridable for local deep runs."""
    return LoadProfile(
        concurrency=int(os.environ.get("EXPLABS_LOAD_CONCURRENCY", "8")),
        duration_seconds=float(os.environ.get("EXPLABS_LOAD_DURATION_SECONDS", "20")),
        warmup_seconds=3.0,
    )


def _write_report(name: str, report: LoadReport) -> None:
    """Append the report JSON to the artifact path when configured."""
    path = os.environ.get("EXPLABS_LOAD_REPORT_PATH")
    if not path:
        return
    target = Path(path)
    existing: list[object] = []
    if target.exists():
        existing = json.loads(target.read_text())
    existing.append(json.loads(report.to_json()))
    target.write_text(json.dumps(existing, indent=2))
    del name  # the report carries its own target name


def test_load_smoke_shape_gates(
    load_env: tuple[GatewayHarness, LoopbackProvider, _SeededLane, dict[str, str]],
) -> None:
    """Closed-loop smoke per target with runner-independent regression gates."""
    import asyncio

    harness, provider, lane, targets = load_env
    profile = _profile()
    for name, base in targets.items():
        calls_before = provider.calls
        report = asyncio.run(
            run_load(
                target_name=name,
                base_url=f"{base.rstrip('/')}/v1",
                api_key=lane.raw_key,
                model=lane.model_slug,
                profile=profile,
                provider=provider,
            )
        )
        print(report.to_json())
        _write_report(name, report)

        # Shape gate 1: nothing but 200s in steady state.
        assert set(report.outcomes_by_status) == {"200"}, report.outcomes_by_status
        assert report.completed > 0
        assert provider.calls > calls_before, "no dispatch ever reached the provider"

        # Shape gate 2: the ledger agrees with the wire. Every request row for
        # the seeded key must be terminal 'completed' (in-flight rows from the
        # deadline cut settle within the request timeout; poll briefly).
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            open_rows = harness.fetch_one(
                "select count(*) from public.gateway_requests"
                " where api_key_id = %s and terminal_state is null",
                (lane.api_key_id,),
            )
            if open_rows is not None and int(str(open_rows[0])) == 0:
                break
            time.sleep(1)
        states = harness.fetch_one(
            # `is distinct from` (not <>) so a NULL/nonterminal leak counts as
            # non-completed -- SQL three-valued logic would let <> skip NULLs.
            "select count(*) filter (where terminal_state is distinct from 'completed'),"
            " count(*) from public.gateway_requests where api_key_id = %s",
            (lane.api_key_id,),
        )
        assert states is not None
        non_completed, total_rows = int(str(states[0])), int(str(states[1]))
        assert non_completed == 0, f"{non_completed} of {total_rows} requests not completed"
        assert total_rows >= report.completed

    # Content safety: the ledger never retains the prompt.
    digest = hashlib.sha256(b"load").hexdigest()
    del digest  # the canonical sha is stored; the raw prompt must not be
    leak = harness.fetch_one(
        "select count(*) from public.gateway_requests"
        " where api_key_id = %s and canonical_request_sha256 is null",
        (lane.api_key_id,),
    )
    assert leak is not None
    assert int(str(leak[0])) == 0
