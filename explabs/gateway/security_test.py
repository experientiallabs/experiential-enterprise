# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Adversarial security suite: exfiltration and tenant-isolation hardening.

Authorized defensive testing of our own gateway. Where ``e2e_test.py``'s s10
proves secrets never *persist* (tables/logs), this suite proves an attacker
holding one valid ``xpl_`` key (or none) cannot *exfiltrate* across the HTTP
boundary at runtime:

* cross-tenant isolation — one org's key cannot invoke another org's private
  model, nor read another org's usage/keys/budgets by passing a foreign
  ``org_id``;
* secret non-leakage — provider base URLs, credentials, and server-internal
  ids never appear in ``/v1/models``, the catalog, or error bodies;
* content non-retention — a canary prompt is never readable back through the
  usage/telemetry API (the ledger is content-free by contract);
* auth-boundary integrity — unknown/malformed/revoked keys fail uniformly
  (no existence oracle), and a customer key cannot reach mutation routes;
* injection resistance — SQL/header-injection-shaped model and header values
  are handled as clean not-founds, never as a boundary bypass.

Local stack or PR sandbox only. These are integration tests, not the fast CI
lane.
"""

from __future__ import annotations

import os
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass

import httpx
import pytest

from explabs.gateway.conftest import GatewayHarness

pytestmark = pytest.mark.integration

_ALIAS_WAIT_SECONDS = 90
# A distinctive string we send as prompt content; it must never be readable
# back through any API surface (the ledger stores only its sha256).
_PROMPT_CANARY = "CANARY-PROMPT-9c3f7a1e-exfil-probe"


def _edge() -> str:
    """The edge base, or skip when the stack is not exposed."""
    dsn = os.environ.get("SUPABASE_DB_URL")
    edge = os.environ.get("EXPLABS_LOAD_EDGE_URL")
    if not dsn or not edge:
        pytest.skip("security suite needs SUPABASE_DB_URL and EXPLABS_LOAD_EDGE_URL")
    return edge.rstrip("/")


@dataclass(frozen=True)
class _Tenant:
    """One org with a key and a private, granted, servable model."""

    org_id: str
    raw_key: str
    api_key_id: str
    model_slug: str
    model_id: str
    provider_row_id: str


def _seed_private_model(harness: GatewayHarness, org_id: str, provider_base_url: str) -> _Tenant:
    """Seed one org-private, granted model served by the loopback provider."""
    key = harness.seed_key(org_id)
    suffix = uuid.uuid4().hex[:10]
    slug = f"gw-sec-{suffix}"
    model_id = str(uuid.uuid4())
    provider_row_id = str(uuid.uuid4())
    harness.connection.execute(
        "insert into public.models (id, slug, display_name, owning_org_id) values (%s, %s, %s, %s)",
        (model_id, slug, "Gateway security", org_id),
    )
    harness.connection.execute(
        """
        insert into public.model_providers (
          id, model_id, provider, provider_model_id, base_url, owning_org_id,
          billing_source, capabilities
        ) values (%s, %s, 'local', 'loopback-sec', %s, %s, 'customer_managed',
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
    return _Tenant(
        org_id=org_id,
        raw_key=key.raw_key,
        api_key_id=key.api_key_id,
        model_slug=slug,
        model_id=model_id,
        provider_row_id=provider_row_id,
    )


@dataclass(frozen=True)
class _TwoTenants:
    """Two isolated tenants (A, B) plus the edge and the provider's real URL."""

    edge: str
    provider_base_url: str
    alice: _Tenant
    bob: _Tenant


@pytest.fixture(scope="module")
def two_tenants() -> Iterator[_TwoTenants]:
    """Two orgs, each with a private granted model on the same loopback."""
    from explabs.gateway.load_harness import LoopbackProvider

    edge = _edge()
    dsn = os.environ["SUPABASE_DB_URL"]
    provider = LoopbackProvider()
    provider.start()
    host = os.environ.get("EXPLABS_LOAD_PROVIDER_HOST", "host.docker.internal")
    provider_url = provider.base_url.replace("127.0.0.1", host)
    harness = GatewayHarness(dsn)
    alice: _Tenant | None = None
    bob: _Tenant | None = None
    try:
        alice = _seed_private_model(harness, harness.seed_org(), provider_url)
        bob = _seed_private_model(harness, harness.seed_org(), provider_url)
        yield _TwoTenants(edge=edge, provider_base_url=provider_url, alice=alice, bob=bob)
    finally:
        for tenant in (alice, bob):
            if tenant is not None:
                harness.connection.execute(
                    "delete from public.model_providers where id = %s", (tenant.provider_row_id,)
                )
                harness.connection.execute(
                    "delete from public.models where id = %s", (tenant.model_id,)
                )
        harness.close()
        provider.stop()


def test_cross_tenant_model_invocation_is_denied(two_tenants: _TwoTenants) -> None:
    """Alice's key cannot invoke Bob's private model even knowing its slug."""
    edge, alice, bob = two_tenants.edge, two_tenants.alice, two_tenants.bob
    with httpx.Client(timeout=30.0) as client:
        # Alice serves her own model fine.
        own = client.post(
            f"{edge}/v1/chat/completions",
            headers={"Authorization": f"Bearer {alice.raw_key}"},
            json={"model": alice.model_slug, "messages": [{"role": "user", "content": "hi"}]},
        )
        assert own.status_code == 200, own.text
        # Bob's private slug is invisible/forbidden to Alice: not a 200, not a
        # 5xx leak — a clean 4xx (not-found/forbidden), indistinguishable from
        # a nonexistent model so it is no existence oracle.
        cross = client.post(
            f"{edge}/v1/chat/completions",
            headers={"Authorization": f"Bearer {alice.raw_key}"},
            json={"model": bob.model_slug, "messages": [{"role": "user", "content": "hi"}]},
        )
        assert 400 <= cross.status_code < 500, cross.status_code
        assert bob.model_slug not in _models_for(client, edge, alice.raw_key)


def test_cross_tenant_control_reads_are_scoped(two_tenants: _TwoTenants) -> None:
    """Alice's key cannot read Bob's org usage/catalog by passing his org_id."""
    edge, alice, bob = two_tenants.edge, two_tenants.alice, two_tenants.bob
    with httpx.Client(timeout=30.0) as client:
        headers = {"Authorization": f"Bearer {alice.raw_key}"}
        # whoami resolves ONLY to Alice's org, never Bob's.
        whoami = client.get(f"{edge}/api/whoami", headers=headers)
        assert whoami.status_code == 200
        assert whoami.json()["org_id"] == alice.org_id
        # Passing Bob's org_id to a scoped read must not return Bob's data:
        # either forbidden/not-found, or (if the route ignores the param) it
        # returns Alice's own scope. It must NEVER return rows scoped to Bob.
        for path in (
            f"/api/gateway/usage/events?org_id={bob.org_id}",
            f"/api/gateway/catalog?org_id={bob.org_id}",
            f"/api/gateway/usage/daily?org_id={bob.org_id}&scope=org",
        ):
            response = client.get(f"{edge}{path}", headers=headers)
            assert response.status_code in (200, 400, 403, 404), (path, response.status_code)
            if response.status_code == 200:
                assert bob.org_id not in response.text, f"{path} leaked Bob's org scope"
                assert bob.model_slug not in response.text, f"{path} leaked Bob's catalog"


def test_no_provider_secrets_or_internal_ids_in_customer_surfaces(
    two_tenants: _TwoTenants,
) -> None:
    """/v1/models and catalog never expose base URLs or server-internal ids."""
    edge, alice = two_tenants.edge, two_tenants.alice
    provider_host = two_tenants.provider_base_url
    with httpx.Client(timeout=30.0) as client:
        headers = {"Authorization": f"Bearer {alice.raw_key}"}
        models = client.get(f"{edge}/v1/models", headers=headers).text
        catalog = client.get(
            f"{edge}/api/gateway/catalog?org_id={alice.org_id}", headers=headers
        ).text
    for surface in (models, catalog):
        # The provider's base URL / host is a server-internal detail.
        assert provider_host not in surface
        assert "loopback-sec" not in surface  # provider_model_id is internal
        assert alice.provider_row_id not in surface
        assert alice.model_id not in surface  # internal uuid, not the slug


def test_prompt_content_is_never_readable_through_the_api(two_tenants: _TwoTenants) -> None:
    """A canary prompt is unreadable via the usage/telemetry API (content-free)."""
    edge, alice = two_tenants.edge, two_tenants.alice
    with httpx.Client(timeout=30.0) as client:
        headers = {"Authorization": f"Bearer {alice.raw_key}"}
        sent = client.post(
            f"{edge}/v1/chat/completions",
            headers=headers,
            json={
                "model": alice.model_slug,
                "messages": [{"role": "user", "content": _PROMPT_CANARY}],
            },
        )
        assert sent.status_code == 200, sent.text
        # Give settlement a moment, then read every usage surface the key can
        # reach; the canary must appear in none of them.
        time.sleep(2)
        for path in (
            f"/api/gateway/usage/events?org_id={alice.org_id}",
            f"/api/gateway/usage/daily?org_id={alice.org_id}&scope=self",
        ):
            body = client.get(f"{edge}{path}", headers=headers).text
            assert _PROMPT_CANARY not in body, f"{path} leaked prompt content"


def test_auth_failures_are_uniform_and_mutation_routes_are_closed(
    two_tenants: _TwoTenants,
) -> None:
    """Unknown/malformed keys 401 uniformly; a customer key cannot mutate."""
    edge, alice = two_tenants.edge, two_tenants.alice
    with httpx.Client(timeout=30.0) as client:
        bodies: set[int] = set()
        # Values httpx will actually transmit (a trailing-space "Bearer " is
        # rejected client-side, so it never reaches the server and is not a
        # server-behavior probe).
        for bad in ("Bearer", "Bearer xpl_nope", "Bearer not-even-a-key", "garbage", "xpl_raw"):
            response = client.get(f"{edge}/v1/models", headers={"Authorization": bad})
            bodies.add(response.status_code)
        # A missing header entirely is also unauthenticated.
        bodies.add(client.get(f"{edge}/v1/models").status_code)
        # Every malformed/absent credential is a 401 — no 403/404/500 variance
        # that would leak which keys exist.
        assert bodies == {401}, bodies
        # A customer key cannot reach an admin mutation (key-limits PUT is
        # admin/session only, not on the customer allowlist): 401 before route.
        put = client.put(
            f"{edge}/api/gateway/keys/{alice.api_key_id}/limits",
            headers={"Authorization": f"Bearer {alice.raw_key}"},
            json={"requests_per_minute": 999999},
        )
        assert put.status_code == 401, put.status_code


def test_injection_shaped_inputs_do_not_bypass_the_boundary(
    two_tenants: _TwoTenants,
) -> None:
    """SQL/header-injection-shaped model names are clean not-founds, not bypass."""
    edge, alice = two_tenants.edge, two_tenants.alice
    injections = [
        "'; drop table gateway_requests;--",
        "%' or '1'='1",
        "../../etc/passwd",
        "model\r\nX-Injected: 1",
        "\0nullbyte",
    ]
    with httpx.Client(timeout=30.0) as client:
        headers = {"Authorization": f"Bearer {alice.raw_key}"}
        for name in injections:
            response = client.post(
                f"{edge}/v1/chat/completions",
                headers=headers,
                json={"model": name, "messages": [{"role": "user", "content": "hi"}]},
            )
            # Handled as an ordinary unknown model (4xx), never a 5xx or a
            # boundary bypass; and Alice's own model still works afterward.
            assert 400 <= response.status_code < 500, (name, response.status_code)
        still_ok = client.post(
            f"{edge}/v1/chat/completions",
            headers=headers,
            json={"model": alice.model_slug, "messages": [{"role": "user", "content": "hi"}]},
        )
        assert still_ok.status_code == 200, "injection storm damaged the boundary"


def _models_for(client: httpx.Client, edge: str, raw_key: str) -> str:
    """Return the raw /v1/models body a key sees."""
    return client.get(f"{edge}/v1/models", headers={"Authorization": f"Bearer {raw_key}"}).text
