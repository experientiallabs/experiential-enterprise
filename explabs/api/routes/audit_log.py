# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Org-admin audit-log reads and CSV export (design E7).

One route: ``GET /api/orgs/{org_id}/audit-log`` returns the newest audit
events first, filterable by action, object type, actor, and time, through the
``audit_log_read`` definer RPC (which clamps the page size server-side).
``?format=csv`` streams the same rows as a ``text/csv`` attachment — the
repo's first export surface, kept a deliberately simple streaming response.
Admin-gated: the audit trail names actors and objects across the whole org,
so member strength does not read it.
"""

from __future__ import annotations

import csv
import io
import json
from collections.abc import Iterator
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from explabs.api.capabilities import EnterpriseCapability, require_capability
from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import JsonObject, SupabaseClient, result_rows

router = APIRouter(prefix="/api", tags=["audit-log"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]

# Mirrors the RPC-side clamp so a full page is distinguishable from the end
# of the stream and an absurd limit fails soft rather than surprising.
_LIMIT_CAP = 200

_CSV_COLUMNS = (
    "event_id",
    "created_at",
    "actor_kind",
    "actor_id",
    "action",
    "object_type",
    "object_id",
    "before",
    "after",
    "context",
)


class AuditEventView(BaseModel):
    """One audit event as the org-admin viewer and export read it."""

    model_config = ConfigDict(frozen=True)

    event_id: str
    org_id: str | None
    actor_kind: str
    actor_id: str | None
    action: str
    object_type: str
    object_id: str
    before: JsonObject | None
    after: JsonObject | None
    context: JsonObject
    created_at: str


class AuditLogResponse(BaseModel):
    """One newest-first page of an organization's audit events."""

    org_id: str
    events: list[AuditEventView]


def _timestamp_or_400(value: str | None) -> str | None:
    """Reject a malformed ``before`` bound here, not as a Postgres 500."""
    if value is None:
        return None
    try:
        datetime.fromisoformat(value)
    except ValueError as error:
        msg = f"Invalid before: {value} (expected an ISO 8601 timestamp)"
        raise ApiError(msg, status_code=400) from error
    return value


def _event_view(row: JsonObject) -> AuditEventView:
    """Project one ``audit_log`` row onto the wire shape."""
    return AuditEventView(
        event_id=str(row["event_id"]),
        org_id=str(row["org_id"]) if row.get("org_id") is not None else None,
        actor_kind=str(row["actor_kind"]),
        actor_id=str(row["actor_id"]) if row.get("actor_id") is not None else None,
        action=str(row["action"]),
        object_type=str(row["object_type"]),
        object_id=str(row["object_id"]),
        before=_json_object_or_none(row.get("before")),
        after=_json_object_or_none(row.get("after")),
        context=_json_object_or_none(row.get("context")) or {},
        created_at=str(row["created_at"]),
    )


def _json_object_or_none(value: object) -> JsonObject | None:
    """Read one nullable jsonb column at the typed boundary."""
    if value is None:
        return None
    if isinstance(value, dict):
        return {str(key): item for key, item in value.items()}
    msg = f"audit log read returned a non-object snapshot: {type(value).__name__}"
    raise ApiError(msg, status_code=502)


def _csv_cell(event: AuditEventView, column: str) -> str:
    """Render one export cell; jsonb snapshots export as compact JSON."""
    value = getattr(event, column)
    if isinstance(value, dict):
        return json.dumps(value, separators=(",", ":"), sort_keys=True)
    return "" if value is None else str(value)


def _csv_lines(events: list[AuditEventView]) -> Iterator[str]:
    """Yield the export header and one CSV line per event."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(_CSV_COLUMNS)
    for event in events:
        writer.writerow(_csv_cell(event, column) for column in _CSV_COLUMNS)
    buffer.seek(0)
    yield from buffer


@router.get("/orgs/{org_id}/audit-log", response_model=None)
def get_audit_log(
    org_id: str,
    client: Client,
    actor: Actor,
    *,
    action: str | None = None,
    object_type: str | None = None,
    actor_id: str | None = None,
    before: str | None = None,
    limit: Annotated[int, Query(ge=1)] = 50,
    format: Literal["json", "csv"] = "json",
) -> AuditLogResponse | StreamingResponse:
    """Return one newest-first page of the org's audit events (admins only).

    Filters are conjunctive and each maps straight onto an ``audit_log_read``
    parameter: ``action`` and ``object_type`` match registry values exactly,
    ``actor_id`` matches the persisted actor identifier, and ``before`` is an
    ISO 8601 exclusive upper bound for paging backwards through time.
    ``?format=csv`` streams the same page as a ``text/csv`` attachment.
    """
    load_org_row(client, org_id)
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.ADMIN,
        not_found=f"Organization not found: {org_id}",
    )
    # /ee gate: the viewer/export surface is enterprise-gated (off by
    # default) and answers 404 when unlicensed — absent, not forbidden. The
    # emit side in explabs/api/audit.py stays core and always-on.
    require_capability(client, org_id, EnterpriseCapability.AUDIT_LOG)
    result = client.rpc(
        "audit_log_read",
        {
            "in_org_id": org_id,
            "in_action": action,
            "in_object_type": object_type,
            "in_actor_id": actor_id,
            "in_before": _timestamp_or_400(before),
            "in_limit": min(limit, _LIMIT_CAP),
        },
    ).execute()
    events = [_event_view(row) for row in result_rows(result)]
    match format:
        case "csv":
            return StreamingResponse(
                _csv_lines(events),
                media_type="text/csv",
                headers={"Content-Disposition": f'attachment; filename="audit-log-{org_id}.csv"'},
            )
        case "json":
            return AuditLogResponse(org_id=org_id, events=events)
