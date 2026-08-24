# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Machine-only internal routes, reachable only with the deployment key.

These carry no session or org actor. The API-key middleware already admits only
the deployment key to ``/api`` routes that are not on the customer-key allowlist
(a customer key gets 401), so the web host's CRON_SECRET-gated internal route is
the scheduler's public edge and this backend route is its deployment-keyed
worker. The explicit deployment-key guard here is defense in depth: it fails
closed with the not-found convention so the route is not probeable.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from explabs.api.routes import ApiError, get_supabase
from explabs.broadcast import run_broadcast
from explabs.broadcast import summary_payload as broadcast_summary_payload
from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.providers.balance_schedule import run_scheduled_balance_fetch, summary_payload

router = APIRouter(prefix="/api/internal", tags=["internal"])


def require_deployment_key(request: Request) -> None:
    """Admit only the trusted deployment credential, or 404 fail-closed."""
    if not getattr(request.state, "deployment_key", False):
        msg = "Not found"
        raise ApiError(msg, status_code=404)


@router.post("/balance-fetch")
def post_balance_fetch(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    _deployment: Annotated[None, Depends(require_deployment_key)],
) -> JsonObject:
    """Run the scheduled balance fetch over every connected account.

    Refreshes each org's provider connections (persisting provider account
    snapshots, honoring per-provider staleness floors) and tool accounts
    (updating each tracked balance). Re-running is safe: floored providers are
    skipped and each fetch overwrites the same row/snapshot lane.
    """
    return summary_payload(run_scheduled_balance_fetch(client))


@router.post("/broadcast")
def post_broadcast(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    _deployment: Annotated[None, Depends(require_deployment_key)],
) -> JsonObject:
    """Drain the captured-prompt broadcast queue to enabled destinations.

    Delivery is at-least-once (rows stamp delivered only after the insert
    succeeded), orgs without an enabled destination keep the platform table
    as their store of record, and failed rows stay queued for the next tick.
    """
    return dict(broadcast_summary_payload(run_broadcast(client)))
