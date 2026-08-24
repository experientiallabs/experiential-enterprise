# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the platform API app: health, org reads, auth, wiring, and CORS."""

from __future__ import annotations

import threading

import pytest
from fastapi.testclient import TestClient

from explabs.api.app import (
    _cors_allow_origin_regex,
    _cors_allow_origins,
    _customer_key_allowed,
    _public_get_allowed,
    create_app,
    default_executor_max_workers,
)

# The package conftest provides the autouse EXPLABS_API_KEY fixture.
from explabs.api.conftest import (
    ACTOR_ID,
    BANNED_SUPERADMIN_KEY_SECRET,
    ORG_ID,
    ORPHAN_SUPERADMIN_KEY_SECRET,
    REVOKED_SUPERADMIN_KEY_SECRET,
    TEST_API_KEY,
)
from explabs.db.fake_supabase_test import FakeQuery, FakeSupabaseClient
from explabs.persistence.storage_cleanup import stage_world_model_cleanup


def _seed_supabase() -> FakeSupabaseClient:
    """Return a fake Supabase client seeded with organization rows."""
    supabase = FakeSupabaseClient()
    supabase.tables["organizations"] = [
        {
            "id": "org-2",
            "slug": "beta-tenant",
            "name": "Beta Tenant",
            "spend_usd": 0,
            "billable_spend_usd": 0,
            "credit_granted_usd": 20,
            "created_at": "2026-06-03T00:00:00Z",
        },
        {
            "id": "org-1",
            "slug": "experiential-labs",
            "name": "Experiential Labs",
            "spend_usd": 12.5,
            "billable_spend_usd": 12.5,
            "credit_granted_usd": 20,
            "created_at": "2026-06-01T00:00:00Z",
        },
    ]
    supabase.tables["organization_members"] = [
        {"org_id": "org-1", "user_id": ACTOR_ID, "role": "admin"},
        {"org_id": "org-2", "user_id": ACTOR_ID, "role": "user"},
    ]
    return supabase


def _api(supabase: FakeSupabaseClient) -> TestClient:
    """Return an authenticated test client acting as the seeded org admin."""
    return TestClient(
        create_app(client=supabase),
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": ACTOR_ID,
        },
    )


def test_health_route_does_not_require_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Health checks remain available without the deployment API key."""
    monkeypatch.delenv("EXPLABS_API_KEY", raising=False)
    api = TestClient(create_app(client=_seed_supabase()))

    response = api.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


class _UnreachableSupabase(FakeSupabaseClient):
    """Fake client whose every query fails at the transport boundary."""

    def table(self, table_name: str) -> FakeQuery:
        msg = "postgrest unreachable"
        raise ConnectionError(msg)


def test_health_ready_reports_ready_on_real_round_trip() -> None:
    """Readiness answers 200 once one PostgREST select round-trips."""
    api = TestClient(create_app(client=_seed_supabase()))

    response = api.get("/health/ready")

    assert response.status_code == 200
    assert response.json() == {"ready": True}


def test_health_ready_is_ready_with_zero_organization_rows() -> None:
    """The probe asserts transport and auth, not content: an empty table is ready."""
    supabase = FakeSupabaseClient()
    supabase.tables["organizations"] = []
    api = TestClient(create_app(client=supabase))

    response = api.get("/health/ready")

    assert response.status_code == 200
    assert response.json() == {"ready": True}


def test_health_ready_answers_503_when_the_dependency_fails() -> None:
    """Any probe failure surfaces as 503 with only the exception class name."""
    api = TestClient(create_app(client=_UnreachableSupabase()))

    response = api.get("/health/ready")

    assert response.status_code == 503
    assert response.json() == {"ready": False, "reason": "ConnectionError"}


def test_health_stays_pure_liveness_when_the_dependency_fails() -> None:
    """/health never inherits the dependency check; a dead database stays live."""
    api = TestClient(create_app(client=_UnreachableSupabase()))

    response = api.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_api_routes_require_bearer_key() -> None:
    """Service-role backed API routes reject missing or incorrect deployment keys."""
    api = TestClient(create_app(client=_seed_supabase()))

    missing = api.get("/api/orgs")
    wrong = api.get("/api/orgs", headers={"Authorization": "Bearer wrong-key"})
    malformed = api.get("/api/orgs", headers={"Authorization": TEST_API_KEY})
    valid = api.get(
        "/api/orgs",
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": ACTOR_ID,
        },
    )

    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert malformed.status_code == 401
    assert valid.status_code == 200


def test_api_routes_fail_closed_without_configured_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """A deployed API without EXPLABS_API_KEY does not serve service-role data."""
    monkeypatch.delenv("EXPLABS_API_KEY", raising=False)
    api = TestClient(create_app(client=_seed_supabase()))

    response = api.get("/api/orgs", headers={"Authorization": f"Bearer {TEST_API_KEY}"})

    assert response.status_code == 503
    assert response.json()["error"] == "EXPLABS_API_KEY must be set"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/agent-models"),
        ("POST", "/api/world-models/wm-1/sessions"),
        ("GET", "/api/sessions/session-1"),
        ("POST", "/api/sessions/session-1/step"),
        ("GET", "/api/sessions/session-1/usage"),
        ("GET", "/api/world-models/wm-1/rollouts"),
        ("POST", "/api/world-models/wm-1/rollouts"),
        ("GET", "/api/rollouts/rollout-1"),
        ("GET", "/api/rollouts/rollout-1/stream"),
        ("POST", "/api/rollouts/rollout-1/fork"),
        ("GET", "/api/world-models/wm-1/scenario-set"),
        ("GET", "/api/world-models/wm-1/scenario-map"),
    ],
)
def test_retired_simulation_http_routes_are_not_mounted(method: str, path: str) -> None:
    """The backend has no executable HTTP entry point for retired Simulation flows."""
    response = _api(_seed_supabase()).request(method, path, json={})

    assert response.status_code == 404


def test_current_app_does_not_mount_retired_world_model_control_families() -> None:
    """The current process exposes preserved history reads only."""
    app = create_app(client=_seed_supabase())
    mounted = {getattr(route, "path", None) for route in app.routes}

    for retired in (
        "/api/account",
        "/api/world-models/{world_model_id}",
        "/api/orgs/{org_id}/traces",
        "/api/orgs/{org_id}/trace-ingests",
        "/api/world-models/{world_model_id}/builds",
        "/api/orgs/{org_id}/runs",
        "/api/registry",
        "/api/catalog/world-models",
        "/api/orgs/{org_id}/telemetry",
    ):
        assert retired not in mounted

    assert "/api/orgs/{org_id}/usage" in mounted
    assert "/api/orgs/{org_id}/serving/requests" in mounted
    assert "/api/orgs/{org_id}/endpoints" not in mounted

    retired_create = _api(_seed_supabase()).post(f"/api/orgs/{ORG_ID}/world-models", json={})
    assert retired_create.status_code == 404


def test_list_orgs_returns_membership_orgs_oldest_first() -> None:
    """Org listing serves the actor's orgs ordered by created_at, with roles."""
    api = _api(_seed_supabase())

    response = api.get("/api/orgs")

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": "org-1",
            "slug": "experiential-labs",
            "name": "Experiential Labs",
            "role": "admin",
            "spend_usd": 12.5,
            "billable_spend_usd": 12.5,
            "credit_granted_usd": 20.0,
            "credit_balance_usd": 7.5,
        },
        {
            "id": "org-2",
            "slug": "beta-tenant",
            "name": "Beta Tenant",
            "role": "user",
            "spend_usd": 0.0,
            "billable_spend_usd": 0.0,
            "credit_granted_usd": 20.0,
            "credit_balance_usd": 20.0,
        },
    ]


def test_list_orgs_returns_every_org_for_platform_admins() -> None:
    """Platform admins list all orgs, each stamped with the admin role."""
    supabase = _seed_supabase()
    supabase.tables["organization_members"] = []
    supabase.tables["platform_admins"] = [{"user_id": ACTOR_ID}]
    api = _api(supabase)

    response = api.get("/api/orgs")

    assert response.status_code == 200
    assert [(row["id"], row["role"]) for row in response.json()] == [
        ("org-1", "platform_admin"),
        ("org-2", "platform_admin"),
    ]


def test_list_orgs_returns_empty_for_memberless_actors() -> None:
    """An actor with no memberships sees an empty org list, never a leak."""
    supabase = _seed_supabase()
    supabase.tables["organization_members"] = []
    api = _api(supabase)

    response = api.get("/api/orgs")

    assert response.status_code == 200
    assert response.json() == []


def test_default_executor_max_workers_sizes_from_the_step_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The to_thread pool reserves both LLM semaphores plus DB headroom."""
    monkeypatch.delenv("EXPLABS_MAX_CONCURRENT_STEPS", raising=False)
    assert default_executor_max_workers() == 40  # 2 * 16 + 8

    monkeypatch.setenv("EXPLABS_MAX_CONCURRENT_STEPS", "4")
    assert default_executor_max_workers() == 16

    monkeypatch.setenv("EXPLABS_MAX_CONCURRENT_STEPS", "0")
    with pytest.raises(ValueError, match="must be positive"):
        default_executor_max_workers()


def test_lifespan_installs_and_tears_down_sized_default_executor() -> None:
    """Startup installs the sized executor; shutdown stops accepting work."""
    app = create_app(client=_seed_supabase())

    with TestClient(app):
        executor = app.state.default_executor
        # The pool is real and named: to_thread work (LLM calls, Supabase
        # round-trips) runs on explicitly provisioned threads.
        name = executor.submit(lambda: threading.current_thread().name).result(timeout=5)
        assert name.startswith("explabs-to-thread")

    with pytest.raises(RuntimeError):
        executor.submit(lambda: None)


def test_lifespan_retries_durable_storage_cleanup_before_serving() -> None:
    """Startup drains cleanup work left by a prior Storage outage or process exit."""
    supabase = _seed_supabase()
    path = "models/deleted-wm/bundle.tar.gz"
    supabase.fake_storage.uploads[("explabs-artifacts", path)] = b"bundle"
    assert (
        stage_world_model_cleanup(
            supabase,
            "deleted-wm",
            {"explabs-artifacts": (path,)},
        )
        is not None
    )
    app = create_app(client=supabase)

    with TestClient(app):
        assert supabase.tables["storage_cleanup_jobs"] == []
        assert ("explabs-artifacts", path) not in supabase.fake_storage.uploads


def test_cors_allow_origins_defaults_to_local_dev(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without configuration, CORS allows only the local development origins."""
    monkeypatch.delenv("EXPLABS_CORS_ALLOW_ORIGINS", raising=False)

    assert _cors_allow_origins() == ["http://127.0.0.1:3000", "http://localhost:3000"]


def test_cors_allow_origins_parses_and_dedupes_configured_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Configured origins are trimmed, de-duplicated, and order-preserving."""
    monkeypatch.setenv(
        "EXPLABS_CORS_ALLOW_ORIGINS",
        " https://app.example.com , https://staging.example.com,https://app.example.com,, ",
    )

    assert _cors_allow_origins() == [
        "https://app.example.com",
        "https://staging.example.com",
    ]


def test_cors_allow_origin_regex_defaults_to_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without configuration (or with blank config), no origin regex is applied."""
    monkeypatch.delenv("EXPLABS_CORS_ALLOW_ORIGIN_REGEX", raising=False)
    assert _cors_allow_origin_regex() is None

    monkeypatch.setenv("EXPLABS_CORS_ALLOW_ORIGIN_REGEX", "   ")
    assert _cors_allow_origin_regex() is None


def test_cors_allow_origin_regex_returns_configured_pattern(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A configured origin regex is passed through trimmed."""
    monkeypatch.setenv(
        "EXPLABS_CORS_ALLOW_ORIGIN_REGEX", r"^https://.*\.preview\.experientiallabs\.ai$ "
    )

    assert _cors_allow_origin_regex() == r"^https://.*\.preview\.experientiallabs\.ai$"


def test_customer_key_allowlist_covers_serving_and_the_yc_claim() -> None:
    """The bearer pass-through covers /v1 serving plus the YC-claim POST.

    The archived Project ingestion surface does not ship in this trial
    distribution, so its routes must never be key-admitted here.
    """
    org_id = "22222222-2222-2222-2222-222222222222"
    project = "/api/projects/33333333-3333-3333-3333-333333333333"

    assert _customer_key_allowed("GET", "/v1/models")
    assert _customer_key_allowed("POST", "/v1/chat/completions")
    assert _customer_key_allowed("POST", "/v1/responses")
    assert _customer_key_allowed("POST", "/v1/messages")
    assert _customer_key_allowed("POST", "/v1/messages/count_tokens")
    assert _customer_key_allowed("POST", f"/api/orgs/{org_id}/yc-claim")

    for method, path in (
        # The archived Project surface does not ship in this distribution, so
        # EVERY route the pre-strip allowlist reasoned about — admitted or
        # denied — must now be denied. Kept exhaustive on purpose: dropping
        # the formerly-admitted paths would quietly narrow the guard.
        ("POST", f"/api/orgs/{org_id}/projects"),
        ("GET", f"/api/orgs/{org_id}/projects"),
        ("GET", f"/api/orgs/{org_id}/projects/support-prod"),
        ("DELETE", f"/api/orgs/{org_id}/projects/support-prod"),
        ("GET", project),
        ("PATCH", project),
        ("POST", f"{project}/archive"),
        ("GET", f"{project}/setup"),
        ("PUT", f"{project}/setup"),
        ("POST", f"{project}/jobs"),
        ("POST", f"{project}/trace-sources/upload"),
        ("GET", f"{project}/trace-sources"),
        ("GET", f"{project}/trace-sources/current"),
        ("POST", f"{project}/trace-acquisitions"),
        ("GET", f"{project}/trace-acquisitions/latest"),
        ("POST", f"{project}/preparations"),
        ("GET", f"{project}/preparation"),
        # Any org-scoped write/read that is not deliberately listed above
        # stays deployment-key/session only.
        ("GET", f"/api/orgs/{org_id}/serving/requests"),
        ("GET", "/api/orgs"),
    ):
        assert not _customer_key_allowed(method, path), (method, path)


def test_public_get_allowlist_covers_browse_reads_only() -> None:
    """The keyless bypass admits the three catalog browse GETs and nothing else."""
    assert _public_get_allowed("GET", "/api/models")
    assert _public_get_allowed("GET", "/api/models/gpt-5")
    assert _public_get_allowed("GET", "/api/models/gpt-5/providers")

    for method, path in (
        ("POST", "/api/models"),
        ("POST", "/api/models/gpt-5/providers"),
        ("PUT", "/api/models/gpt-5/waterfall"),
        ("GET", "/api/models/gpt-5/waterfall"),
        ("GET", "/v1/models"),
        ("GET", "/api/orgs"),
        ("GET", "/api/models/gpt-5/providers/extra"),
    ):
        assert not _public_get_allowed(method, path)


def test_public_catalog_browse_reads_are_keyless_and_anonymous() -> None:
    """Keyless GET on the browse routes reaches the real catalog handler.

    ``_PUBLIC_GET_ROUTES`` opens the models browse GETs to unauthenticated
    callers, so the request passes the api-key middleware and reaches the
    catalog handler (which renders public-only rows) rather than being refused
    with a 401. The list route answers 200; the per-model routes reach the
    handler too (a missing slug self-corrects to 404, never a 401 auth refusal).
    """
    api = TestClient(create_app(client=_seed_supabase()))

    listing = api.get("/api/models")
    assert listing.status_code == 200
    for path in ("/api/models/gpt-5", "/api/models/gpt-5/providers"):
        assert api.get(path).status_code != 401, path

    # The web app's deployment-key path is unaffected: presenting the key still
    # authenticates, so the handler can serve the richer org-aware catalog.
    authed = api.get(
        "/api/models",
        headers={"Authorization": f"Bearer {TEST_API_KEY}", "X-Explabs-Actor-Id": ACTOR_ID},
    )
    assert authed.status_code == 200


def test_keyless_browse_read_cannot_forge_an_actor() -> None:
    """A keyless caller's actor header is stripped, never trusted to widen reads.

    The actor header is honored only when an authenticated caller asserts it. A
    keyless request that named another user could otherwise read that tenant's
    private catalog rows, so the bypass strips it before the handler: a forged
    ``X-Explabs-Actor-Id`` must yield exactly the public view a header-less
    keyless read returns.
    """
    api = TestClient(create_app(client=_seed_supabase()))

    clean = api.get("/api/models")
    forged = api.get("/api/models", headers={"X-Explabs-Actor-Id": ACTOR_ID})

    assert clean.status_code == 200
    assert forged.status_code == 200
    assert forged.json() == clean.json()


def test_public_catalog_writes_and_openai_models_stay_keyed() -> None:
    """Only the browse GETs open: writes and the OpenAI model list stay keyed."""
    api = TestClient(create_app(client=_seed_supabase()))

    assert api.post("/api/models", json={}).status_code == 401
    assert api.post("/api/models/gpt-5/providers", json={}).status_code == 401
    assert api.put("/api/models/gpt-5/waterfall", json={}).status_code == 401
    # A catalog read that is not a browse route stays behind the key.
    assert api.get("/api/models/gpt-5/waterfall").status_code == 401
    # The OpenAI-compatible surface is the gateway worker's transparent /v1
    # edge: it never opens to keyless callers, and with no worker wired in
    # this test it fails closed with a 503 rather than serving anything.
    assert api.get("/v1/models").status_code == 503


def test_reaper_client_is_memoized_on_the_app(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reaper passes must not rebuild the client (eight sessions) every 60s."""
    import sys

    from explabs.api.app import _reaper_client

    supabase = _seed_supabase()
    app = create_app(client=supabase)
    assert _reaper_client(app) is supabase

    app.state.supabase_client = None
    calls: list[int] = []

    def fake_client(*, service_role: bool = False) -> FakeSupabaseClient:
        _ = service_role
        calls.append(1)
        return _seed_supabase()

    # `explabs.api` re-exports a FastAPI instance named `app`, which shadows
    # the submodule on attribute access; fetch the module itself.
    monkeypatch.setattr(sys.modules["explabs.api.app"], "get_supabase_client", fake_client)
    first = _reaper_client(app)
    second = _reaper_client(app)
    assert first is second
    assert len(calls) == 1


def test_gateway_only_mounts_health_and_v1_and_nothing_else() -> None:
    """A gateway pod carries only health and the WMO-free customer surface."""
    supabase = _seed_supabase()
    app = create_app(client=supabase, gateway_only=True)
    api = TestClient(
        app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": ACTOR_ID,
        },
    )

    assert api.get("/health").json() == {"ok": True}
    assert api.get("/api/orgs").status_code == 404
    assert api.get(f"/api/orgs/{ORG_ID}/endpoints").status_code == 404
    mounted = {getattr(route, "path", None) for route in app.routes}
    assert "/v1/models" in mounted
    assert "/v1/chat/completions" in mounted
    assert "/v1/responses" in mounted
    assert "/v1/messages" in mounted
    assert "/v1/messages/count_tokens" in mounted


def test_gateway_only_reads_the_deployment_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    """A deployed pod opts in through EXPLABS_GATEWAY_ONLY."""
    monkeypatch.setenv("EXPLABS_GATEWAY_ONLY", "1")
    app = create_app(client=_seed_supabase())
    assert app.state.gateway_only is True
    monkeypatch.delenv("EXPLABS_GATEWAY_ONLY")
    assert create_app(client=_seed_supabase()).state.gateway_only is False


def test_control_only_mounts_api_and_no_public_v1() -> None:
    """The stage/production control pod cannot shadow the public gateway."""
    app = create_app(client=_seed_supabase(), control_only=True)
    api = TestClient(
        app,
        headers={
            "Authorization": f"Bearer {TEST_API_KEY}",
            "X-Explabs-Actor-Id": ACTOR_ID,
        },
    )

    assert api.get("/api/orgs").status_code == 200
    assert api.get("/v1/models").status_code == 404
    mounted = {getattr(route, "path", None) for route in app.routes}
    assert "/api/orgs/{org_id}/usage" in mounted
    assert "/v1/models" not in mounted
    assert "/v1/chat/completions" not in mounted


def test_control_only_reads_the_deployment_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dedicated control pod opts in through EXPLABS_CONTROL_ONLY."""
    monkeypatch.setenv("EXPLABS_CONTROL_ONLY", "true")
    app = create_app(client=_seed_supabase())

    assert app.state.control_only is True
    assert app.state.gateway_only is False


def test_deployment_shapes_are_mutually_exclusive() -> None:
    """One process cannot claim more than one process-only role."""
    with pytest.raises(ValueError, match="mutually exclusive"):
        create_app(client=_seed_supabase(), gateway_only=True, control_only=True)
    with pytest.raises(ValueError, match="mutually exclusive"):
        create_app(gateway_only=True, gateway_worker_only=True)
    with pytest.raises(ValueError, match="mutually exclusive"):
        create_app(control_only=True, gateway_worker_only=True)


def test_gateway_worker_role_takes_no_supabase_client() -> None:
    """The worker role talks to Postgres directly; a PostgREST client is a bug."""
    with pytest.raises(ValueError, match="no Supabase client"):
        create_app(client=_seed_supabase(), gateway_worker_only=True)


def test_gateway_only_runs_no_reapers() -> None:
    """Gateway replicas add no duplicate cleanup load; the API owns cleanup."""
    supabase = _seed_supabase()
    app = create_app(client=supabase, gateway_only=True)
    with TestClient(app):
        assert getattr(app.state, "storage_cleanup_reaper", None) is None


def test_lifespan_closes_only_the_app_owned_worker_client() -> None:
    """Gateway teardown closes its owned worker proxy client exactly once."""

    class StubAsyncClient:
        """Record whether app teardown closed the client."""

        def __init__(self) -> None:
            """Initialize an open client."""
            self.close_calls = 0

        async def close(self) -> None:
            """Record one asynchronous close."""
            self.close_calls += 1

    app = create_app(client=_seed_supabase(), gateway_only=True)
    worker_client = StubAsyncClient()
    app.state.gateway_worker_http_client = worker_client
    app.state.owns_gateway_worker_http_client = True

    with TestClient(app):
        pass

    assert worker_client.close_calls == 1


def test_unknown_v1_routes_answer_in_openai_error_shape() -> None:
    """An SDK probing an unserved /v1 surface reads body.error.message.

    FastAPI's default {"detail": "Not Found"} surfaces as an EMPTY error in
    OpenAI SDKs; /api keeps the platform's own shapes.
    """
    supabase = _seed_supabase()
    api = TestClient(
        create_app(client=supabase, gateway_only=True),
        headers={"Authorization": f"Bearer {TEST_API_KEY}"},
    )

    probe = api.post("/v1/embeddings", json={"model": "x", "input": "y"})
    assert probe.status_code == 404
    body = probe.json()["error"]
    assert body["code"] == "not_found"
    assert isinstance(body["message"], str)
    assert body["message"]


class TestSuperadminKeys:
    """xpladmin_ bearer authentication (the operator machine credential)."""

    def test_superadmin_key_reaches_admin_surface(
        self, superadmin_api: TestClient, supabase: FakeSupabaseClient
    ) -> None:
        """A live key owned by a platform admin passes the admin gate."""
        response = superadmin_api.get("/api/admin/model-promotions")
        assert response.status_code == 200
        assert response.json() == {"promotions": []}

    def test_superadmin_key_passes_org_gates(
        self, superadmin_api: TestClient, supabase: FakeSupabaseClient
    ) -> None:
        """The actor carries platform-admin authority, so org gates admit it."""
        supabase.tables["gateway_usage_daily"] = []
        response = superadmin_api.get(
            "/api/gateway/usage/daily", params={"org_id": ORG_ID, "scope": "org"}
        )
        assert response.status_code == 200

    def test_superadmin_key_ignores_actor_header(
        self, superadmin_api: TestClient, supabase: FakeSupabaseClient
    ) -> None:
        """The key IS the actor: a smuggled actor header must not be honored.

        Proven through the whoami surface: a platform-admin actor gets its
        deliberate 409 (operators have no single org), even when the header
        names an org member whose whoami would otherwise resolve.
        """
        response = superadmin_api.get("/api/whoami", headers={"X-Explabs-Actor-Id": ACTOR_ID})
        assert response.status_code == 409

    def test_revoked_superadmin_key_is_401(self, supabase: FakeSupabaseClient) -> None:
        """A revoked key is a dead credential everywhere."""
        client = TestClient(
            create_app(client=supabase),
            headers={"Authorization": f"Bearer {REVOKED_SUPERADMIN_KEY_SECRET}"},
        )
        assert client.get("/api/admin/model-promotions").status_code == 401

    def test_orphaned_superadmin_key_is_401(self, supabase: FakeSupabaseClient) -> None:
        """A live key whose owner left platform_admins authenticates nothing."""
        client = TestClient(
            create_app(client=supabase),
            headers={"Authorization": f"Bearer {ORPHAN_SUPERADMIN_KEY_SECRET}"},
        )
        assert client.get("/api/admin/model-promotions").status_code == 401

    def test_banned_owner_superadmin_key_is_401(self, supabase: FakeSupabaseClient) -> None:
        """A banned operator holds no authority, even on an unrevoked key.

        `record_user_ban` revokes the keys in the ban transaction; this pins
        the auth-time check that also refuses a key whose owner is banned.
        """
        client = TestClient(
            create_app(client=supabase),
            headers={"Authorization": f"Bearer {BANNED_SUPERADMIN_KEY_SECRET}"},
        )
        assert client.get("/api/admin/model-promotions").status_code == 401

    def test_customer_key_still_never_reaches_admin_surface(self, customer_api: TestClient) -> None:
        """The org-scoped xpl_ credential class is unchanged by the new branch."""
        assert customer_api.get("/api/admin/model-promotions").status_code == 401
