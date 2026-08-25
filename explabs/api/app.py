# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""FastAPI backend for the Experiential Labs Project platform."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import re
import secrets
from collections.abc import AsyncIterator, Mapping
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from types import ModuleType
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

from explabs.api.credits import organization_credit_view
from explabs.api.load_shed import InFlightLimitMiddleware, configured_max_concurrency
from explabs.api.openai_errors import openai_error_response
from explabs.api.request_timing import RequestTimingMiddleware
from explabs.api.routes import ApiError, get_supabase
from explabs.api.routes.admin_org_lookup import router as admin_org_lookup_router
from explabs.api.routes.aliases import router as aliases_router
from explabs.api.routes.audit_log import router as audit_log_router
from explabs.api.routes.capabilities import router as capabilities_router
from explabs.api.routes.data_controls import router as data_controls_router
from explabs.api.routes.entitlements import router as entitlements_router
from explabs.api.routes.experiential_cloud_admin import router as experiential_cloud_admin_router
from explabs.api.routes.gateway_admin import router as gateway_admin_router
from explabs.api.routes.gateway_admin import whoami_router
from explabs.api.routes.gateway_usage import router as gateway_usage_router
from explabs.api.routes.identities import router as identities_router
from explabs.api.routes.internal import router as internal_router
from explabs.api.routes.keys import router as keys_router
from explabs.api.routes.model_promotions import router as model_promotions_router
from explabs.api.routes.models_catalog import router as models_catalog_router
from explabs.api.routes.org_data import router as org_data_router
from explabs.api.routes.org_domains import router as org_domains_router
from explabs.api.routes.org_join_requests import router as org_join_requests_router
from explabs.api.routes.org_labels import router as org_labels_router
from explabs.api.routes.platform_settings import router as platform_settings_router
from explabs.api.routes.provider_connections import router as provider_connections_router
from explabs.api.routes.recommended_models import router as recommended_models_router
from explabs.api.routes.scim import router as scim_router
from explabs.api.routes.scim_admin import router as scim_admin_router
from explabs.api.routes.serving_gateway import router as serving_gateway_router
from explabs.api.routes.serving_requests import router as serving_requests_router
from explabs.api.routes.spend_alerts import router as spend_alerts_router
from explabs.api.routes.sso import router as sso_router
from explabs.api.routes.teams import router as teams_router
from explabs.api.routes.telemetry_traces import router as telemetry_traces_router
from explabs.api.routes.tool_accounts import router as tool_accounts_router
from explabs.api.routes.usage import router as usage_router
from explabs.api.routes.usage_import import router as usage_import_router
from explabs.api.routes.welcome_trigger import router as welcome_trigger_router
from explabs.api.routes.yc import router as yc_router
from explabs.api.tenancy import (
    ACTOR_HEADER,
    OrgRole,
    RequestActor,
    get_request_actor,
)
from explabs.db.client import get_supabase_client
from explabs.db.repositories import SupabaseClient, find_one_by_columns
from explabs.db.stores.api_key_store import ApiKeyStore
from explabs.db.stores.platform_admin_key_store import (
    SUPERADMIN_KEY_PREFIX,
    PlatformAdminKeyStore,
)
from explabs.persistence.storage_cleanup import drain_storage_cleanup_jobs

# ModuleType | None because a module's presence is the seam: this
# enterprise-trial distribution ships without the archived Project surface, so
# the seam is permanently None and those routers are never mounted.
_archived_routes: ModuleType | None = None

type JsonObject = dict[str, Any]

EXPLABS_API_KEY_ENV = "EXPLABS_API_KEY"

# The role stamped on every org a platform admin lists: admins are not
# members, so no membership row names a real role for them.
_PLATFORM_ADMIN_ROLE = "platform_admin"

_DEFAULT_CORS_ALLOW_ORIGINS = ("http://127.0.0.1:3000", "http://localhost:3000")

_STORAGE_CLEANUP_INTERVAL_SECONDS = 60

logger = logging.getLogger(__name__)

# Existing deployment knob retained for the shared ``asyncio.to_thread`` pool.
# The retired session/rollout executors no longer consume it directly.
DEFAULT_MAX_CONCURRENT_STEPS = 16


def _env_flag(name: str) -> bool:
    """Read a boolean deployment flag from the environment."""
    return os.environ.get(name, "").strip().lower() in {"1", "true"}


def default_executor_max_workers() -> int:
    """Size the loop's default ``to_thread`` executor for the serving mix.

    Everything the API runs off the event loop shares this pool, including
    provider-backed control-plane work and short Supabase reads/writes. Keep
    the existing deployment sizing contract while the provider workflow is
    replaced later in the convergence train.

    Returns:
        ``2 * EXPLABS_MAX_CONCURRENT_STEPS + 8`` (default 40).

    Raises:
        ValueError: If the configured bound is not a positive integer.
    """
    max_concurrent = int(
        os.environ.get("EXPLABS_MAX_CONCURRENT_STEPS", str(DEFAULT_MAX_CONCURRENT_STEPS))
    )
    if max_concurrent < 1:
        msg = f"EXPLABS_MAX_CONCURRENT_STEPS must be positive: {max_concurrent}"
        raise ValueError(msg)
    return 2 * max_concurrent + 8


@contextlib.asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Install an explicitly sized default executor for the app's lifetime.

    ``asyncio.to_thread`` (used for every LLM call and Supabase round-trip)
    runs on the loop's default executor; sizing it here keeps one API
    container able to serve many concurrent streams without short DB writes
    queueing behind long LLM threads. The executor is exposed on
    ``app.state.default_executor`` for tests and shut down without waiting on
    teardown so in-flight threads never block server exit.

    Teardown closes the app-owned gateway worker proxy client before the
    executor goes away.
    """
    executor = ThreadPoolExecutor(
        max_workers=default_executor_max_workers(),
        thread_name_prefix="explabs-to-thread",
    )
    asyncio.get_running_loop().set_default_executor(executor)
    app.state.default_executor = executor
    reapers: list[asyncio.Task[None]] = []
    if not getattr(app.state, "gateway_only", False):
        await _drain_storage_cleanup(app)
        cleanup_reaper = asyncio.create_task(
            _storage_cleanup_reaper(app), name="explabs-storage-cleanup-reaper"
        )
        app.state.storage_cleanup_reaper = cleanup_reaper
        reapers = [cleanup_reaper]
    try:
        yield
    finally:
        for reaper in reapers:
            reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reaper
        worker_client = getattr(app.state, "gateway_worker_http_client", None)
        if worker_client is not None and getattr(
            app.state, "owns_gateway_worker_http_client", False
        ):
            await worker_client.close()
        executor.shutdown(wait=False)


async def _storage_cleanup_reaper(app: FastAPI) -> None:
    """Retry durable Storage cleanup jobs for the application lifetime."""
    while True:
        await asyncio.sleep(_STORAGE_CLEANUP_INTERVAL_SECONDS)
        await _drain_storage_cleanup(app)


def _reaper_client(app: FastAPI) -> SupabaseClient:
    """The app's shared Supabase client, constructed and memoized on first use.

    Memoized on purpose: without it, a pod that has not yet served a request
    would build a client on every 60s reaper pass, and with the pooled client
    that is eight httpx sessions per build, each holding keepalive
    connections. The same slot get_supabase memoizes into, so the first
    request and the first reaper pass share one client.
    """
    client = app.state.supabase_client
    if client is None:
        client = get_supabase_client(service_role=True)
        app.state.supabase_client = client
    return client


async def _drain_storage_cleanup(app: FastAPI) -> None:
    """Run one best-effort cleanup pass without blocking startup or requests."""
    try:
        client = _reaper_client(app)
        await asyncio.to_thread(drain_storage_cleanup_jobs, client)
    except Exception:  # noqa: BLE001 - cleanup outages cannot block API startup
        # A database or Storage outage must not prevent the API from starting;
        # the durable rows remain available for the next periodic pass.
        logger.warning("Durable Storage cleanup pass failed", exc_info=True)


def _cors_allow_origins() -> list[str]:
    """Return the CORS allow-origins list.

    Reads `EXPLABS_CORS_ALLOW_ORIGINS` (comma-separated) so a PR preview can
    allow its dynamic origin. Falls back to the local development origins.

    Returns:
        Ordered, de-duplicated list of allowed origins.
    """
    raw = os.environ.get("EXPLABS_CORS_ALLOW_ORIGINS", "")
    configured = [origin.strip() for origin in raw.split(",") if origin.strip()]
    origins = configured or list(_DEFAULT_CORS_ALLOW_ORIGINS)
    seen: dict[str, None] = {}
    for origin in origins:
        seen.setdefault(origin, None)
    return list(seen)


def _cors_allow_origin_regex() -> str | None:
    r"""Return an optional CORS allow-origin regex.

    Preview URLs are dynamic per deployment, so they cannot be enumerated as
    exact origins. `EXPLABS_CORS_ALLOW_ORIGIN_REGEX` (e.g.
    `^https://pr-[0-9]+\.preview\.experientiallabs\.ai$`) lets a preview API
    allow the whole preview-domain pattern.

    Returns:
        The configured regex, or None when unset.
    """
    regex = os.environ.get("EXPLABS_CORS_ALLOW_ORIGIN_REGEX", "").strip()
    return regex or None


def create_app(  # noqa: PLR0915 - one coherent app factory; the body is a flat router-registration manifest
    client: SupabaseClient | None = None,
    *,
    gateway_only: bool | None = None,
    control_only: bool | None = None,
    gateway_worker_only: bool | None = None,
) -> FastAPI:
    """Create the FastAPI app.

    The Supabase client lives on ``app.state`` so tests can inject a fake while
    deployed routes construct the real dependency lazily.

    The retired ``EXPLABS_PROJECT_SERVING_ONLY`` role is no longer read: the
    project-router serving lane is gone and no API role imports Experiential at
    runtime. A stale deployment that still sets the flag boots a standard app
    whose protected routes all reject because that pod carries no
    ``EXPLABS_API_KEY``; integration-P7 removes the pod itself.

    Args:
        client: Optional Supabase client override for tests.
        gateway_only: Test override for ``EXPLABS_GATEWAY_ONLY``. The gateway
            process mounts only health and the engine-free public ``/v1`` proxy.
        control_only: Test override for ``EXPLABS_CONTROL_ONLY``. The dedicated
            control process mounts current ``/api`` routes but no public
            ``/v1`` surface.
        gateway_worker_only: Test override for ``EXPLABS_GATEWAY_WORKER_ONLY``.
            The gateway worker process serves Experiential's OpenAI-compatible data
            plane over Postgres and none of the platform ``/api`` surface.

    Returns:
        Configured FastAPI app.

    """
    if gateway_only is None:
        gateway_only = _env_flag("EXPLABS_GATEWAY_ONLY")
    if control_only is None:
        control_only = _env_flag("EXPLABS_CONTROL_ONLY")
    if gateway_worker_only is None:
        gateway_worker_only = _env_flag("EXPLABS_GATEWAY_WORKER_ONLY")
    if gateway_only + control_only + gateway_worker_only > 1:
        msg = "Platform process-only deployment flags are mutually exclusive"
        raise ValueError(msg)
    if gateway_worker_only:
        if client is not None:
            msg = "The gateway worker role takes no Supabase client"
            raise ValueError(msg)
        # Lazily import the ONE process role allowed to load Experiential, so
        # the api and control roles stay engine-free at runtime (asserted by
        # explabs/legacy_serving_provenance_test.py).
        from explabs.gateway.worker import create_gateway_worker_app

        return create_gateway_worker_app()
    app = FastAPI(title="Experiential Labs Platform API", lifespan=_lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_allow_origins(),
        allow_origin_regex=_cors_allow_origin_regex(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.supabase_client = client
    # Readiness probes never reuse the memoized request-path client: each
    # probe builds a FRESH service-role client so a wedged shared pool cannot
    # mask a database outage (mirroring the gateway worker's fresh-connection
    # readiness). Tests inject their fake through this factory seam.
    app.state.readiness_client_factory = (lambda: client) if client is not None else None
    app.state.gateway_only = gateway_only
    app.state.control_only = control_only
    app.state.gateway_worker_http_client = None
    app.state.owns_gateway_worker_http_client = False
    _register_api_key_middleware(app)
    _register_error_handlers(app)
    _register_health_route(app)
    if not gateway_only:
        _register_org_routes(app)
        _mount_archived_routes(app)
        app.include_router(usage_router)
        app.include_router(platform_settings_router)
        app.include_router(model_promotions_router)
        app.include_router(recommended_models_router)
        app.include_router(experiential_cloud_admin_router)
        app.include_router(org_labels_router)
        app.include_router(telemetry_traces_router)
        app.include_router(yc_router)
        app.include_router(welcome_trigger_router)
        app.include_router(admin_org_lookup_router)
        app.include_router(gateway_usage_router)
        app.include_router(usage_import_router)
        app.include_router(serving_requests_router)
        app.include_router(org_data_router)
        app.include_router(org_join_requests_router)
        app.include_router(provider_connections_router)
        app.include_router(tool_accounts_router)
        app.include_router(models_catalog_router)
        app.include_router(aliases_router)
        app.include_router(gateway_admin_router)
        app.include_router(whoami_router)
        app.include_router(keys_router)
        app.include_router(identities_router)
        app.include_router(spend_alerts_router)
        app.include_router(audit_log_router)
        app.include_router(capabilities_router)
        app.include_router(data_controls_router)
        app.include_router(entitlements_router)
        app.include_router(org_domains_router)
        app.include_router(sso_router)
        app.include_router(scim_router)
        app.include_router(scim_admin_router)
        app.include_router(teams_router)
        app.include_router(internal_router)
    if not control_only:
        app.include_router(serving_gateway_router)
    # Bound the control plane before auth or routing does any work for a
    # request the pod has no capacity for: past the bound it answers 503
    # immediately instead of queueing in memory (2026-08-22, the dashboard-read
    # herd that OOM-killed the api pod). Health probes and the /v1 data plane
    # are exempt; see explabs/api/load_shed.py.
    shed_limit = configured_max_concurrency()
    if shed_limit > 0:
        app.add_middleware(InFlightLimitMiddleware, limit=shed_limit)
    # Outermost on purpose (Starlette middleware added last wraps everything):
    # the timing line must include auth middleware, routing, and the full
    # streamed /v1 worker relay.
    app.add_middleware(RequestTimingMiddleware)
    return app


def _mount_archived_routes(app: FastAPI) -> None:
    """Mount the archived Project surface when its module is present.

    Called at the exact slot those routers used to be mounted inline (after
    the org routes, before the usage router), so route order is unchanged.
    This distribution ships no such module, so the call is a no-op.

    Args:
        app: FastAPI app under assembly.
    """
    if _archived_routes is not None:
        _archived_routes.register(app)


type _RouteRule = tuple[frozenset[str], re.Pattern[str]]

# Customer keys reach inference plus the management surface an agent needs
# ("an agent must be able to do via API everything a human does"): gateway
# usage, key limits, and the resolved catalog reads; the org's key list plus
# BYOK provider-connection reads and writes (connect/rotate a provider key,
# verify it, refresh its spend); and the models-management routes (catalog
# reads plus custom-model/deployment/waterfall writes). On every admitted
# mutation the key itself implies the acting org and the handlers enforce
# that identity. Tenancy still scopes every call to the key's own org at user
# strength; every other mutation remains deployment-key-only. The archived
# Project trace-ingestion entries are appended below when their module is
# present; this distribution ships without it, so no Project route is
# key-admitted.
_BASE_CUSTOMER_KEY_ROUTES: tuple[_RouteRule, ...] = (
    (frozenset({"GET"}), re.compile(r"^/v1/models$")),
    (frozenset({"POST"}), re.compile(r"^/v1/chat/completions$")),
    (frozenset({"GET"}), re.compile(r"^/api/gateway/usage/daily$")),
    (frozenset({"GET"}), re.compile(r"^/api/gateway/usage/events$")),
    (frozenset({"POST"}), re.compile(r"^/api/gateway/usage/import$")),
    (frozenset({"GET"}), re.compile(r"^/api/gateway/keys/[^/]+/limits$")),
    (frozenset({"GET"}), re.compile(r"^/api/gateway/catalog$")),
    (frozenset({"GET"}), re.compile(r"^/api/whoami$")),
    (frozenset({"GET"}), re.compile(r"^/api/keys$")),
    # The YC launch-grant claim (the agent lane of the pasted YC onboarding
    # prompt). The handler resolves the key to the human who minted it, so
    # claimed_by stays a real user and both uniqueness legs hold; a
    # creatorless key is refused there (explabs/api/routes/yc.py).
    (frozenset({"POST"}), re.compile(r"^/api/orgs/[^/]+/yc-claim$")),
    (frozenset({"GET"}), re.compile(r"^/api/orgs/[^/]+/provider-connections$")),
    (frozenset({"PUT"}), re.compile(r"^/api/orgs/[^/]+/provider-connections/[^/]+$")),
    (frozenset({"POST"}), re.compile(r"^/api/orgs/[^/]+/provider-connections/[^/]+/check$")),
    (
        frozenset({"POST"}),
        re.compile(r"^/api/orgs/[^/]+/provider-connections/[^/]+/spend-refresh$"),
    ),
    (frozenset({"GET", "POST"}), re.compile(r"^/api/models$")),
    (frozenset({"GET"}), re.compile(r"^/api/models/[^/]+$")),
    (frozenset({"GET", "POST"}), re.compile(r"^/api/models/[^/]+/providers$")),
    (frozenset({"GET", "PUT"}), re.compile(r"^/api/models/[^/]+/waterfall$")),
    (frozenset({"POST"}), re.compile(r"^/v1/responses$")),
    (frozenset({"POST"}), re.compile(r"^/v1/messages$")),
    (frozenset({"POST"}), re.compile(r"^/v1/messages/count_tokens$")),
    # Router-free telemetry trace ingestion an onboarding agent drives:
    # reserve a signed Storage upload, finalize it, or live-pull external
    # traces as org telemetry, then read them back to verify a count. No
    # Project, preparation, or optimize job is reachable from these routes
    # (explabs/trace_acquisition/telemetry_ingest.py), so they can never
    # launch a build.
    (frozenset({"POST"}), re.compile(r"^/api/orgs/[^/]+/telemetry/traces/upload$")),
    (
        frozenset({"POST"}),
        re.compile(r"^/api/orgs/[^/]+/telemetry/traces/[^/]+/finalize$"),
    ),
    (frozenset({"POST"}), re.compile(r"^/api/orgs/[^/]+/telemetry/traces/pull$")),
    (frozenset({"GET"}), re.compile(r"^/api/orgs/[^/]+/telemetry/traces$")),
    (
        frozenset({"GET"}),
        re.compile(r"^/api/orgs/[^/]+/telemetry/traces/[^/]+/spans$"),
    ),
)


def _compose_customer_key_routes(
    archived: tuple[_RouteRule, ...] | None,
) -> tuple[_RouteRule, ...]:
    """Compose the ``xpl_``-key edge allowlist for this deployment.

    The allowlist is consumed as an unordered ``any()`` match
    (:func:`_customer_key_allowed`) and the archived entries share no
    method+pattern with the current ones, so appending them after the base
    tuple admits exactly the same calls as the pre-seam interleaved tuple.

    Args:
        archived: The archived Project-lane entries, or ``None`` when the
            distribution ships without the archived surface, as this one does.

    Returns:
        The full allowlist this deployment enforces.
    """
    if archived is None:
        return _BASE_CUSTOMER_KEY_ROUTES
    return _BASE_CUSTOMER_KEY_ROUTES + archived


_CUSTOMER_KEY_ROUTES: tuple[_RouteRule, ...] = _compose_customer_key_routes(
    None if _archived_routes is None else _archived_routes.CUSTOMER_KEY_ROUTES
)


def _customer_key_allowed(method: str, path: str) -> bool:
    """Return whether the serving surface admits customer keys for this call."""
    return any(
        method in methods and pattern.match(path) is not None
        for methods, pattern in _CUSTOMER_KEY_ROUTES
    )


# The public models catalog browse surface: everything on the platform is
# public except credits and keys, so these catalog reads answer without any
# credential at all. The handlers render anonymously (get_optional_actor ->
# public-only rows, owning_org_id null, a customer-safe view with no secrets);
# this bypass lets a keyless caller reach them instead of being turned away at
# the edge. Browse reads only: the OpenAI-compatible /v1/models stays keyed,
# and every models-management WRITE stays keyed via _CUSTOMER_KEY_ROUTES.
_PUBLIC_GET_ROUTES: tuple[re.Pattern[str], ...] = (
    re.compile(r"^/api/models$"),
    re.compile(r"^/api/models/[^/]+$"),
    re.compile(r"^/api/models/[^/]+/providers$"),
)


def _public_get_allowed(method: str, path: str) -> bool:
    """Return whether this call is a keyless public catalog browse read."""
    return method == "GET" and any(
        pattern.match(path) is not None for pattern in _PUBLIC_GET_ROUTES
    )


def _strip_actor_header(request: Request) -> None:
    """Drop the actor header so an unauthenticated caller cannot assert one.

    ``X-Explabs-Actor-Id`` is trusted only when asserted by an authenticated
    caller from its own verified session; a keyless public read must resolve
    to no actor, so removing the header keeps a forged one from naming another
    tenant whose private rows the anonymous handler would then reveal.
    """
    lowered = ACTOR_HEADER.lower().encode("latin-1")
    request.scope["headers"] = [
        (name, value) for name, value in request.scope["headers"] if name.lower() != lowered
    ]


def _register_api_key_middleware(app: FastAPI) -> None:
    """Authenticate backend API routes.

    Two credentials ride the same bearer slot: the deployment key (full
    access, held by trusted services such as the web app) and customer API
    keys (org-scoped rows in ``api_keys``). Allowlisted ``/v1`` serving
    routes pass through untouched — the gateway worker validates the bearer.
    """
    app.add_middleware(_ApiKeyAuthMiddleware)


class _ApiKeyAuthMiddleware:
    """Pure-ASGI credential gate for ``/api`` and ``/v1``.

    Pure ASGI on purpose, like ``RequestTimingMiddleware``: Starlette's
    ``BaseHTTPMiddleware`` adds an anyio task group and a stream pair per
    request, which the serving hot path (every ``/v1`` relay) paid on each
    call just to be waved through. The hot allowlisted ``/v1`` branch below
    forwards the raw ASGI call with no Request construction at all; every
    other branch builds the ``Request`` lazily and keeps the original
    authentication logic byte for byte.
    """

    def __init__(self, app: ASGIApp) -> None:
        """Wrap the downstream ASGI app."""
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Protect service-role backed API routes from public callers."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope["path"]
        if not path.startswith(("/api/", "/v1/")):
            await self.app(scope, receive, send)
            return

        method = scope["method"]
        # CORS preflight carries no credentials by design; let CORSMiddleware answer it.
        if method == "OPTIONS":
            await self.app(scope, receive, send)
            return

        # The gateway worker authenticates /v1 callers itself (see
        # _api_key_rejection); skip building a Request for the serving lane.
        if path.startswith("/v1/") and _customer_key_allowed(method, path):
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive)
        rejection = await _api_key_rejection(request)
        if rejection is None:
            await self.app(scope, receive, send)
            return

        # The public models catalog browse reads need no credential:
        # everything on the platform is public except credits and keys. When a
        # keyless caller hits one, serve it anonymously instead of rejecting.
        # A presented credential still authenticates normally above (so the web
        # app's deployment key keeps its richer org-aware catalog, and a wrong
        # key still fails), and the serving-only edge never mounts these routes.
        # Strip any actor header first: it is trusted only when asserted by an
        # authenticated caller, so an unauthenticated request must resolve to no
        # actor and can never name another tenant to read its private rows.
        project_serving_only = getattr(request.app.state, "project_serving_only", False)
        if (
            not project_serving_only
            and _request_api_key(request) is None
            and _public_get_allowed(method, path)
        ):
            _strip_actor_header(request)
            await self.app(scope, receive, send)
            return
        await rejection(scope, receive, send)


async def _api_key_rejection(request: Request) -> Response | None:
    """Authenticate one protected request or return its safe rejection.

    Args:
        request: Incoming protected API or OpenAI request.

    Returns:
        A surface-shaped rejection response, or ``None`` after successful
        deployment-key or customer-key authentication.
    """
    # The gateway worker authenticates /v1 callers itself; the edge proxy
    # forwards Authorization, Idempotency-Key, and X-Client-Request-Id
    # verbatim, so edge pre-validation would add a second auth authority and
    # break worker-side replay. Unlisted /v1 paths keep the deployment gate
    # in front of the proxy's fail-closed 404.
    path = request.url.path
    if path.startswith("/v1/") and _customer_key_allowed(request.method, path):
        return None

    expected_key = os.environ.get(EXPLABS_API_KEY_ENV)
    if not expected_key:
        return _auth_rejection(request, 503, f"{EXPLABS_API_KEY_ENV} must be set")

    provided_key = _request_api_key(request)
    if provided_key is None:
        return _auth_rejection(request, 401, "Unauthorized")
    if secrets.compare_digest(provided_key, expected_key):
        # Control-plane tenancy and request timing read which credential
        # authenticated; stamp the trusted deployment identity.
        request.state.deployment_key = True
        return None
    if provided_key.startswith(SUPERADMIN_KEY_PREFIX):
        return await _authenticate_superadmin_key(request, provided_key)
    return await _authenticate_customer_key(request, provided_key)


async def _authenticate_superadmin_key(request: Request, provided_key: str) -> Response | None:
    """Resolve an ``xpladmin_`` bearer as a platform-operator credential.

    Three checks on EVERY request: the secret must hash to a live
    ``platform_admin_keys`` row, that row's owner must still be in
    ``platform_admins``, and the owner must not be banned. Dropping an
    operator from platform_admins kills all of their keys instantly, and a
    banned operator's keys are dead too — ``record_user_ban`` revokes them in
    the ban transaction, and this check holds even for a ban applied before
    that revocation existed. On success the operator identity is stamped on
    ``request.state`` and tenancy resolves a platform-admin actor (the key IS
    the actor; any actor header is ignored). No route allowlist: a superadmin
    key reaches everything a platform-admin session can. Minting/revocation
    deliberately have no API route — they are web-session-only — so this
    credential cannot self-propagate if leaked.
    """
    store = PlatformAdminKeyStore(get_supabase(request))
    record = await asyncio.to_thread(store.find_active_by_secret, provided_key)
    if record is None:
        return _auth_rejection(request, 401, "Unauthorized")
    admin_row, ban_row = await asyncio.gather(
        asyncio.to_thread(
            find_one_by_columns,
            get_supabase(request),
            "platform_admins",
            {"user_id": record.user_id},
        ),
        asyncio.to_thread(
            find_one_by_columns, get_supabase(request), "user_bans", {"user_id": record.user_id}
        ),
    )
    if admin_row is None:
        # The owner lost operator status; the key is a dead credential.
        return _auth_rejection(request, 401, "Unauthorized")
    if ban_row is not None:
        # A banned account holds no authority through any credential class.
        return _auth_rejection(request, 401, "Unauthorized")
    request.state.superadmin_user_id = record.user_id
    if _needs_last_used_touch(record.last_used_at):
        with contextlib.suppress(Exception):
            await asyncio.to_thread(store.touch_last_used, record.id)
    return None


async def _authenticate_customer_key(request: Request, provided_key: str) -> Response | None:
    """Resolve a non-deployment bearer credential as a customer API key.

    On success the key's org is stamped on ``request.state.api_key_org_id``
    for tenancy scoping and None is returned; otherwise the rejection
    response. Sync Supabase round-trips stay off the event loop. Allowlisted
    ``/v1`` routes never reach this: they bypass edge auth entirely, so this
    seam serves customer-key access to allowlisted control reads.
    """
    # Gate on the allowlist before the key lookup: unlisted routes answer
    # 401 whether or not the key exists, so probing them cannot confirm
    # that a stolen key is live.
    if not _customer_key_allowed(request.method, request.url.path):
        return _auth_rejection(request, 401, "Unauthorized")
    store = ApiKeyStore(get_supabase(request))
    record = await asyncio.to_thread(store.find_active_by_secret, provided_key)
    if record is None:
        return _auth_rejection(request, 401, "Unauthorized")
    request.state.api_key_org_id = record.org_id
    request.state.api_key_id = record.id
    # Usage visibility only; a failed bump must never fail the request. Fresh
    # keys skip the write entirely: last_used_at is a display field, and the
    # serving hot path must not pay a cross-region UPDATE per request to keep
    # it exact to the second.
    if _needs_last_used_touch(record.last_used_at):
        with contextlib.suppress(Exception):
            await asyncio.to_thread(store.touch_last_used, record.id)
    return None


# How stale last_used_at may grow before a request pays the UPDATE again.
_API_KEY_TOUCH_INTERVAL_SECONDS = 60.0


def _needs_last_used_touch(last_used_at: str | None) -> bool:
    """Whether the key's ``last_used_at`` is stale enough to be worth a write.

    Args:
        last_used_at: The row's current ISO-8601 value, if any.

    Returns:
        True when the field is missing, unparseable, or older than the touch
        interval; False while it is fresh.
    """
    if last_used_at is None:
        return True
    try:
        last = datetime.fromisoformat(last_used_at)
    except ValueError:
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=UTC)
    return (datetime.now(tz=UTC) - last).total_seconds() >= _API_KEY_TOUCH_INTERVAL_SECONDS


def _auth_rejection(request: Request, status_code: int, message: str) -> Response:
    """Shape an auth rejection for the surface being called.

    ``/api`` keeps the platform's ``{"error": message}`` contract; ``/v1``
    answers in OpenAI's error shape, because an OpenAI SDK reads
    ``body["error"]["message"]`` and would surface the string shape as an
    empty error.
    """
    if request.url.path.startswith("/v1/"):
        code = "invalid_api_key" if status_code == 401 else "service_unavailable"
        return openai_error_response(
            status_code, message, err_type="invalid_request_error", code=code
        )
    return JSONResponse({"error": message}, status_code=status_code)


def _request_api_key(request: Request) -> str | None:
    """Return the API key supplied by a trusted server-side caller."""
    authorization = request.headers.get("authorization")
    if authorization is None:
        return None
    scheme, _, credential = authorization.partition(" ")
    if scheme.lower() == "bearer" and credential:
        return credential
    return None


def _register_error_handlers(app: FastAPI) -> None:
    """Register API exception handlers.

    Args:
        app: FastAPI app.
    """

    @app.exception_handler(ApiError)
    async def api_error_handler(_request: Request, error: ApiError) -> JSONResponse:
        """Return typed route errors with their explicit status codes."""
        body = {"error": str(error)}
        if error.code is not None:
            body["code"] = error.code
        if error.action is not None:
            body["action"] = error.action
        return JSONResponse(body, status_code=error.status_code)

    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(
        request: Request,
        _error: RequestValidationError,
    ) -> Response:
        """Hide validation internals on OpenAI-compatible serving routes."""
        if request.url.path.startswith("/v1/"):
            return openai_error_response(
                400,
                "Invalid OpenAI request",
                err_type="invalid_request_error",
                code="invalid_request",
            )
        return await request_validation_exception_handler(request, _error)


# Bound the readiness round-trip well under typical probe budgets: the client
# pool's own HTTP timeout (120s default) is sized for data work, not probes.
_READINESS_PROBE_TIMEOUT_SECONDS = 5.0


def _register_health_route(app: FastAPI) -> None:
    """Register the probe routes every deployment shape serves.

    Args:
        app: FastAPI app.
    """

    @app.get("/health")
    def health() -> JsonObject:
        """Return API health."""
        return {"ok": True}

    @app.get("/health/ready")
    async def health_ready(request: Request) -> JSONResponse:
        """Return readiness from one real PostgREST round-trip.

        The probe asserts transport and auth only: a fresh service-role client
        selects one ``organizations`` id, and zero rows is still ready. Any
        failure (connect, TLS, auth, timeout) answers 503 with the exception
        class name — never the message, which could carry connection detail.
        """

        def probe() -> None:
            factory = request.app.state.readiness_client_factory
            probe_client: SupabaseClient = (
                factory() if factory is not None else get_supabase_client(service_role=True)
            )
            probe_client.table("organizations").select("id").limit(1).execute()

        try:
            await asyncio.wait_for(
                asyncio.to_thread(probe), timeout=_READINESS_PROBE_TIMEOUT_SECONDS
            )
        except Exception as error:  # noqa: BLE001 - any dependency failure means not ready
            return JSONResponse({"ready": False, "reason": type(error).__name__}, status_code=503)
        return JSONResponse({"ready": True})


def _register_org_routes(app: FastAPI) -> None:
    """Register the control-plane org listing.

    Args:
        app: FastAPI app.
    """

    @app.get("/api/orgs")
    def list_orgs(
        client: Annotated[SupabaseClient, Depends(get_supabase)],
        actor: Annotated[RequestActor, Depends(get_request_actor)],
    ) -> list[JsonObject]:
        """Return the actor's organizations ordered oldest first, uncapped.

        The web tier canonicalizes org ids and slugs from this list, so it
        must be COMPLETE: a capped fetch would make every org past the cap
        unreachable in the UI for platform admins. Pages past the PostgREST
        row cap by ``created_at`` with ``id`` as the stable tiebreaker.

        Each entry carries the actor's ``role`` in the org: the membership
        row's role for ordinary users, ``user`` for API-key actors (a key
        serves exactly its org at user strength), and ``platform_admin``
        across every org for platform admins.
        """

        def all_org_rows(filter_ids: list[str] | None) -> list[JsonObject]:
            page_size = 1000
            rows: list[JsonObject] = []
            offset = 0
            while True:
                query = client.table("organizations").select("*")
                if filter_ids is not None:
                    query = query.in_("id", filter_ids)
                result = (
                    query.order("created_at")
                    .order("id")
                    .range(offset, offset + page_size - 1)
                    .execute()
                )
                page = list(result.data)
                rows.extend(page)
                if len(page) < page_size:
                    return rows
                offset += page_size

        if actor.is_platform_admin:
            return [_org_view(row, role=_PLATFORM_ADMIN_ROLE) for row in all_org_rows(None)]
        if actor.api_key_org_id is not None:
            rows = all_org_rows([actor.api_key_org_id])
            return [_org_view(row, role=OrgRole.USER.value) for row in rows]
        memberships = (
            client.table("organization_members")
            .select("org_id, role")
            .eq("user_id", actor.user_id)
            .execute()
        )
        roles = {str(row["org_id"]): str(row["role"]) for row in memberships.data}
        if not roles:
            return []
        rows = all_org_rows(sorted(roles))
        return [_org_view(row, role=roles[str(row["id"])]) for row in rows]


def _org_view(row: Mapping[str, object], *, role: str) -> JsonObject:
    """Project the API-visible columns out of an organizations table row."""
    return {
        "id": row.get("id"),
        "slug": row.get("slug"),
        "name": row.get("name"),
        "role": role,
        **organization_credit_view(row),
    }


app = create_app()


def main() -> None:
    """Run the API server."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8030)
    args = parser.parse_args()
    import uvicorn

    # No uvicorn limit_concurrency here: it sheds on open connections and would
    # answer 503 on the health probes and on the gateway worker's /v1 streams,
    # both of which ride this same entrypoint. Load shedding is an in-flight
    # bound on the control plane instead (explabs/api/load_shed.py).
    # No uvicorn access log either: RequestTimingMiddleware already logs one
    # richer line per request (route, status, duration, db attribution), so the
    # access line was a second stdout write per request on the serving path.
    uvicorn.run("explabs.api:app", host=args.host, port=args.port, access_log=False)
