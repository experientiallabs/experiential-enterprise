# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Serving-request routes: the endpoint observability read path.

The Telemetry page reads everything through the tenant half: a keyset-
paginated request list, a single-request detail with the stored bodies, and
a window summary (aggregates + activity buckets + served endpoints).
Filtering and aggregation execute inside the database; this layer gates org
membership, parses the window shorthand, and shapes responses.

The last route is a different audience. Every row also records HOW the call
was routed (the policy's reason for the chosen model, the provider runtime
id behind it, the routing decision's own cost, the metered leg, and a cluster
when a cluster-routing policy served the call), and the Telemetry half serves
none of that mechanism. The chosen ``model`` itself is tenant-visible in the
detail view (the gateway-launch reclassification), but WHY it was chosen is
not. The per-call audit is therefore platform-admin only and 404s for
everyone else, exactly like the runs panel.

The platform-admin audit is the only route that exposes the decision
mechanism: reason, provider runtime id, router cost, cluster identity, and
metering leg.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends

from explabs.api.historical_serving import (
    serving_bucket_view,
    serving_endpoint_view,
    serving_request_audit_view,
    serving_request_detail_view,
    serving_request_view,
    serving_stats_view,
)
from explabs.api.routes import ApiError, get_supabase
from explabs.api.tenancy import (
    OrgRole,
    RequestActor,
    get_request_actor,
    require_org_role,
    require_platform_admin,
)
from explabs.db.repositories import (
    JsonObject,
    RepositoryError,
    SupabaseClient,
    find_one_by_columns,
)
from explabs.db.stores.serving_request_store import ServingRequestRecord, ServingRequestStore

router = APIRouter(prefix="/api", tags=["serving"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]

# Window shorthand the frontend's picker sends -> (lookback, bucket width).
# 24h charts hourly; the longer windows chart daily.
_WINDOWS: dict[str, tuple[timedelta, int]] = {
    "24h": (timedelta(hours=24), 3_600),
    "7d": (timedelta(days=7), 86_400),
    "30d": (timedelta(days=30), 86_400),
}

_DEFAULT_WINDOW = "7d"

# The list RPC caps at this bound regardless of the requested limit.
_LIST_CAP = 200


def _window(window: str | None) -> tuple[str, str, int]:
    """Resolve a window shorthand to (key, after-timestamp, bucket seconds)."""
    key = window or _DEFAULT_WINDOW
    if key not in _WINDOWS:
        msg = f"Unknown window: {key} (expected one of {', '.join(sorted(_WINDOWS))})"
        raise ApiError(msg, status_code=400)
    lookback, bucket_seconds = _WINDOWS[key]
    after = (datetime.now(tz=UTC) - lookback).isoformat()
    return key, after, bucket_seconds


def _uuid_or_400(value: str, name: str) -> str:
    """Reject a malformed uuid at the boundary: Postgres would 22P02 -> 500."""
    try:
        UUID(value)
    except ValueError as error:
        msg = f"Invalid {name}: {value} (expected a uuid)"
        raise ApiError(msg, status_code=400) from error
    return value


def _timestamp_or_400(value: str, name: str) -> str:
    """Reject a malformed timestamp at the boundary for the same reason."""
    try:
        datetime.fromisoformat(value)
    except ValueError as error:
        msg = f"Invalid {name}: {value} (expected an ISO 8601 timestamp)"
        raise ApiError(msg, status_code=400) from error
    return value


def _status_or_400(value: str | None) -> str | None:
    """Reject unknown statuses: a typo must not read as an empty result."""
    if value is not None and value not in ("ok", "error"):
        msg = f"Unknown status: {value} (expected ok or error)"
        raise ApiError(msg, status_code=400)
    return value


def _require_viewer(client: SupabaseClient, actor: RequestActor, org_id: str) -> None:
    """Gate a read on org membership."""
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.USER,
        not_found=f"Organization not found: {org_id}",
    )


@router.get("/orgs/{org_id}/serving/requests")
def list_serving_requests(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    endpoint: str | None = None,
    project_id: str | None = None,
    status: str | None = None,
    window: str | None = None,
    cursor_ts: str | None = None,
    cursor_id: str | None = None,
    cursor_after: str | None = None,
    limit: int = 50,
) -> JsonObject:
    """List an organization's serving requests, newest first.

    ``next_cursor`` is returned while a full page came back; echo its fields
    back as ``cursor_ts``/``cursor_id``/``cursor_after`` to fetch the next
    page. ``cursor_after`` freezes the window's lower bound across pages:
    recomputing "now - 7d" per page would let the oldest rows slide out of
    the window mid-pagination and silently vanish.
    """
    _require_viewer(client, actor, org_id)
    if endpoint is not None:
        _uuid_or_400(endpoint, "endpoint")
    if project_id is not None:
        _uuid_or_400(project_id, "project_id")
    if endpoint is not None and project_id is not None:
        msg = "Pass endpoint or project_id, not both"
        raise ApiError(msg, status_code=400)
    _status_or_400(status)
    if (cursor_ts is None) != (cursor_id is None):
        msg = "Pass cursor_ts and cursor_id together or not at all"
        raise ApiError(msg, status_code=400)
    if cursor_ts is not None:
        _timestamp_or_400(cursor_ts, "cursor_ts")
    if cursor_id is not None:
        _uuid_or_400(cursor_id, "cursor_id")
    if cursor_after is not None:
        after = _timestamp_or_400(cursor_after, "cursor_after")
    else:
        _, after, _ = _window(window)
    effective_limit = min(max(limit, 1), _LIST_CAP)
    items = ServingRequestStore(client).list_requests(
        org_id,
        endpoint_id=endpoint,
        project_id=project_id,
        status=status,
        after=after,
        cursor_ts=cursor_ts,
        cursor_id=cursor_id,
        limit=effective_limit,
    )
    next_cursor: JsonObject | None = None
    if len(items) == effective_limit:
        next_cursor = {"ts": items[-1].created_at, "id": items[-1].id, "after": after}
    return {
        "requests": [serving_request_view(item) for item in items],
        "next_cursor": next_cursor,
    }


def _load_request(client: SupabaseClient, request_id: str) -> ServingRequestRecord:
    """Fetch one request row, or fail with a typed 404.

    A malformed id is a 404 rather than a 400: Postgres would answer 22P02 ->
    500, and a caller holding a bad request id is holding a request that does
    not exist.

    Raises:
        ApiError: 404 when the id is not a uuid or names no row.
    """
    msg = f"Serving request not found: {request_id}"
    try:
        UUID(request_id)
    except ValueError as error:
        raise ApiError(msg, status_code=404) from error
    try:
        return ServingRequestStore(client).get_request(request_id)
    except RepositoryError as error:
        raise ApiError(msg, status_code=404) from error


@router.get("/orgs/{org_id}/serving/requests/{request_id}")
def get_serving_request(
    org_id: str,
    request_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Fetch one serving request with its stored request/response bodies.

    The view is built from an allowlist of outcome columns, so the routing
    fields are absent by construction rather than by being denied one by one.
    """
    _require_viewer(client, actor, org_id)
    record = _load_request(client, request_id)
    if record.org_id != org_id:
        msg = f"Serving request not found: {request_id}"
        raise ApiError(msg, status_code=404)
    return {"request": serving_request_detail_view(record)}


@router.get("/orgs/{org_id}/serving/endpoints")
def list_serving_endpoints(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """List endpoints that have served traffic.

    The light "has this org ever served" probe: the sidebar gates the
    Telemetry entry on a non-empty result without paying for window stats.
    """
    _require_viewer(client, actor, org_id)
    endpoints = ServingRequestStore(client).endpoints(org_id)
    return {"endpoints": [serving_endpoint_view(record) for record in endpoints]}


@router.get("/orgs/{org_id}/serving/summary")
async def serving_summary(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    endpoint: str | None = None,
    project_id: str | None = None,
    window: str | None = None,
) -> JsonObject:
    """Summarize a window: hero aggregates, activity buckets, endpoints.

    ``endpoints`` is unfiltered by design: it feeds the filter dropdown and
    the "has this org ever served" gate, so it must not vanish when a filter
    matches nothing.

    The three reads are independent, so they are issued together rather than
    one after another. ``async def`` means FastAPI runs this on the event loop
    instead of in its threadpool, so EVERY blocking call here has to go through
    a worker thread, the membership check included; a blocking call left inline
    would stall the loop for far longer than the fan-out saves.
    """
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    if endpoint is not None:
        _uuid_or_400(endpoint, "endpoint")
    if project_id is not None:
        _uuid_or_400(project_id, "project_id")
    if endpoint is not None and project_id is not None:
        msg = "Pass endpoint or project_id, not both"
        raise ApiError(msg, status_code=400)
    key, after, bucket_seconds = _window(window)
    store = ServingRequestStore(client)
    stats, buckets, endpoints = await asyncio.gather(
        asyncio.to_thread(
            store.stats,
            org_id,
            endpoint_id=endpoint,
            project_id=project_id,
            after=after,
        ),
        asyncio.to_thread(
            store.buckets,
            org_id,
            endpoint_id=endpoint,
            project_id=project_id,
            after=after,
            bucket_seconds=bucket_seconds,
        ),
        asyncio.to_thread(store.endpoints, org_id),
    )
    return {
        "window": key,
        "bucket_seconds": bucket_seconds,
        "stats": serving_stats_view(stats),
        "buckets": [serving_bucket_view(bucket) for bucket in buckets],
        "endpoints": [serving_endpoint_view(record) for record in endpoints],
    }


# --- operator audit -----------------------------------------------------------------------------


@router.get("/admin/serving-requests/{request_id}")
def get_serving_request_audit(
    request_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Explain one served call: which model the policy chose, and why.

    The operator answer to "why did this request route there", cross-org and
    platform-admin only. It carries the whole decision the serving runtime
    made — the chosen pool entry and the provider runtime id behind it, the
    policy's own reason string (the only field carrying its evidence), the
    routing decision's cost, the metered leg — beside the tokens, cost, latency
    and status to read them against. Cluster id and label are included but are
    populated only by cluster-routing policies; a static policy or a sticky
    affinity hit reports neither.

    Not org-scoped in the path on purpose: an operator debugging a customer
    report has the completion id the customer quoted and not necessarily the
    tenant, and that id already addresses the log row. One class of row is NOT
    reachable that way — a call that failed before routing gets a server-minted
    id behind a 502, so the customer never receives one; those are found by
    listing the endpoint's errors, not by id. The org rides in the response,
    resolved to a name like the runs detail does.

    Bodies are omitted; the tenant-facing detail route serves those. A
    non-admin gets the same 404 as a missing route, so this surface is not
    enumerable from a tenant session.
    """
    require_platform_admin(actor)
    record = _load_request(client, request_id)
    org_row = find_one_by_columns(client, "organizations", {"id": record.org_id})
    return {
        "request": serving_request_audit_view(record),
        "org": (
            {"id": record.org_id, "name": str(org_row["name"]), "slug": str(org_row["slug"])}
            if org_row is not None
            else None
        ),
    }
