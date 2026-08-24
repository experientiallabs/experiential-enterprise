# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Org-scoped trace ingestion that lands external traces as platform telemetry.

These routes are the router-free counterpart to the Project trace surface: an
onboarding agent (or the dashboard) connects an observability provider or
uploads a trace export, and the traces become organization telemetry only. No
optimizer Project, preparation, or optimization job is created — see
``explabs/trace_acquisition/telemetry_ingest.py``. An ``xpl_`` org key drives
the whole flow at user strength.
"""

from __future__ import annotations

import asyncio
import json
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from explabs.api.routes import ApiError, get_supabase
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.db.stores.trace_ingest_store import TraceIngestRecord, TraceIngestStore
from explabs.trace_acquisition.clickhouse_trace import (
    ClickHouseTraceError,
    ClickHouseTraceSettings,
    ClickHouseTraceStore,
)
from explabs.trace_acquisition.connectors import (
    AcquisitionErrorCode,
    ConnectorError,
    TraceTransportKind,
)
from explabs.trace_acquisition.formats import (
    MAX_REMOTE_RECORDS,
    MAX_SOURCE_LABEL_LENGTH,
    TraceUploadFormat,
    TraceUploadValidationError,
)
from explabs.trace_acquisition.telemetry_ingest import (
    TelemetryTraceIngestService,
    TelemetryTraceNotFoundError,
    TelemetryTraceResult,
    TelemetryTraceUploadTicket,
)

router = APIRouter(prefix="/api/orgs", tags=["telemetry-traces"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]

_NOT_FOUND = "Organization not found"
_TRACE_NOT_FOUND = "Telemetry trace ingest not found"
_TRACE_READS_DISABLED = "ClickHouse trace reads are not enabled"
_TRACE_READ_FAILED = "ClickHouse trace read returned invalid data"

# Connector failures reduced to the HTTP status an agent should act on.
_CONNECTOR_STATUS: dict[AcquisitionErrorCode, int] = {
    AcquisitionErrorCode.BAD_CREDENTIALS: 400,
    AcquisitionErrorCode.CONNECTION_MISSING: 400,
    AcquisitionErrorCode.INVALID_SOURCE_CONFIG: 422,
    AcquisitionErrorCode.OBJECT_TOO_LARGE: 413,
    AcquisitionErrorCode.RATE_LIMITED: 429,
}


class TelemetryTraceUploadRequest(BaseModel):
    """JSON reservation for one signed Storage upload (no object bytes)."""

    model_config = ConfigDict(extra="forbid")

    source_kind: TraceUploadFormat
    source_label: str = Field(min_length=1, max_length=MAX_SOURCE_LABEL_LENGTH)


class TelemetryTraceUploadTicketView(BaseModel):
    """Customer-safe signed-upload ticket (no service credentials or path)."""

    model_config = ConfigDict(frozen=True)

    ingest_id: str
    source_kind: TraceUploadFormat
    source_label: str
    signed_url: str
    token: str
    expires_in: int
    method: str = "PUT"

    @classmethod
    def from_ticket(cls, ticket: TelemetryTraceUploadTicket) -> TelemetryTraceUploadTicketView:
        """Project only the short-lived upload capability."""
        return cls(
            ingest_id=ticket.ingest_id,
            source_kind=ticket.source_kind,
            source_label=ticket.source_label,
            signed_url=ticket.signed_url,
            token=ticket.token,
            expires_in=ticket.expires_in,
        )


class TelemetryTraceAcceptedView(BaseModel):
    """Idempotent finalize result after durable work is enqueued."""

    model_config = ConfigDict(frozen=True)

    ingest_id: str
    status: str
    projection_status: str | None
    error_code: str | None = None
    trace_count: int | None = None
    byte_size: int | None = None
    sha256: str | None = None

    @classmethod
    def from_record(cls, record: TraceIngestRecord) -> TelemetryTraceAcceptedView:
        """Project the receipt without storage locators or credentials."""
        return cls(
            ingest_id=record.id,
            status="accepted",
            projection_status=(
                record.trace_projection_status.value
                if record.trace_projection_status is not None
                else None
            ),
            error_code=record.error_code,
            trace_count=record.trace_count,
            byte_size=record.byte_size,
            sha256=record.object_sha256,
        )


class TelemetryTracePullRequest(BaseModel):
    """Secret-carrying request for one live remote trace pull."""

    model_config = ConfigDict(extra="forbid")

    transport_kind: TraceTransportKind
    source_kind: TraceUploadFormat
    source_label: str = Field(min_length=1, max_length=MAX_SOURCE_LABEL_LENGTH)
    credential: str = Field(min_length=1)
    config: JsonObject = Field(default_factory=dict)
    since_at: AwareDatetime | None = None
    max_records: int = Field(default=MAX_REMOTE_RECORDS, ge=1, le=MAX_REMOTE_RECORDS)


class TelemetryTraceIngestView(BaseModel):
    """Customer-safe terminal ingest projection (no storage locator/credential)."""

    model_config = ConfigDict(frozen=True)

    ingest_id: str
    source_kind: TraceUploadFormat
    source_label: str
    transport_kind: TraceTransportKind
    trace_count: int
    byte_size: int
    sha256: str

    @classmethod
    def from_result(cls, result: TelemetryTraceResult) -> TelemetryTraceIngestView:
        """Project only fields safe for a tenant response (drops result_path)."""
        return cls(
            ingest_id=result.ingest_id,
            source_kind=result.source_kind,
            source_label=result.source_label,
            transport_kind=result.transport_kind,
            trace_count=result.trace_count,
            byte_size=result.byte_size,
            sha256=result.sha256,
        )


class TelemetryTraceRowView(BaseModel):
    """One landed telemetry ingest as read back for verification."""

    model_config = ConfigDict(frozen=True)

    ingest_id: str
    kind: str
    provider: str | None
    source_kind: str | None
    source_label: str | None
    status: str
    trace_count: int
    projection_status: str | None
    projected_rows: int | None
    error_code: str | None = None

    @classmethod
    def from_record(cls, record: TraceIngestRecord) -> TelemetryTraceRowView:
        """Project one ``trace_ingests`` row into a customer-safe row view."""
        source = record.source
        return cls(
            ingest_id=record.id,
            kind=_source_text(source, "kind") or "unknown",
            provider=_source_text(source, "provider"),
            source_kind=_source_text(source, "source_kind"),
            source_label=_source_text(source, "source_label"),
            status=record.status.value,
            trace_count=record.trace_count or 0,
            projection_status=(
                record.trace_projection_status.value
                if record.trace_projection_status is not None
                else None
            ),
            projected_rows=record.trace_projected_rows,
            error_code=record.error_code,
        )


class TelemetryTraceListView(BaseModel):
    """The org's landed telemetry traces plus the verify-count totals."""

    model_config = ConfigDict(frozen=True)

    traces: tuple[TelemetryTraceRowView, ...]
    total_ingests: int
    total_traces: int


class TelemetryTraceSpanView(BaseModel):
    """One normalized ClickHouse trace row safe for the owning tenant."""

    model_config = ConfigDict(frozen=True)

    record_index: int
    event_type: str
    trace_id: str
    span_id: str
    parent_span_id: str | None
    name: str
    span_kind: str
    status: str
    started_at_ns: int | None
    duration_ns: int | None
    model: str | None
    input_tokens: int
    output_tokens: int
    attributes: JsonObject

    @classmethod
    def from_row(cls, row: JsonObject) -> TelemetryTraceSpanView:
        """Parse a ClickHouse JSONEachRow result without exposing raw payloads."""
        raw_attributes = row.get("attributes_json")
        try:
            attributes = json.loads(raw_attributes) if isinstance(raw_attributes, str) else {}
        except json.JSONDecodeError as error:
            msg = "ClickHouse trace row contains invalid attributes"
            raise ValueError(msg) from error
        if not isinstance(attributes, dict):
            msg = "ClickHouse trace row attributes are not an object"
            raise TypeError(msg)
        return cls.model_validate({**row, "attributes": attributes})


class TelemetryTraceSpansView(BaseModel):
    """One keyset-independent page of normalized trace rows."""

    model_config = ConfigDict(frozen=True)

    spans: tuple[TelemetryTraceSpanView, ...]
    limit: int
    offset: int


def _source_text(source: JsonObject, key: str) -> str | None:
    """Read one string field from a stored, secret-free source descriptor."""
    value = source.get(key)
    return value if isinstance(value, str) else None


def _authorize_org(client: SupabaseClient, actor: RequestActor, org_id: str) -> None:
    """Apply the org gate at user strength (an ``xpl_`` key acts for its org)."""
    require_org_role(client, actor, org_id, OrgRole.USER, not_found=_NOT_FOUND)


def _connector_error(error: ConnectorError) -> ApiError:
    """Map a sanitized connector failure to its actionable HTTP status."""
    status = _CONNECTOR_STATUS.get(error.code, 502)
    return ApiError(f"Trace pull failed: {error.code.value}", status_code=status)


@router.post(
    "/{org_id}/telemetry/traces/upload",
    status_code=201,
    response_model=TelemetryTraceUploadTicketView,
)
async def create_org_telemetry_trace_upload(
    org_id: str,
    client: Client,
    actor: Actor,
    body: TelemetryTraceUploadRequest,
) -> TelemetryTraceUploadTicketView:
    """Reserve an ingest-scoped path and return a short-lived signed upload."""
    await asyncio.to_thread(_authorize_org, client, actor, org_id)
    try:
        ticket = await asyncio.to_thread(
            TelemetryTraceIngestService(client).prepare_signed_upload,
            org_id=org_id,
            source_kind=body.source_kind,
            source_label=body.source_label,
            created_by=actor.user_id,
        )
    except TraceUploadValidationError as error:
        raise ApiError(str(error), status_code=422) from error
    return TelemetryTraceUploadTicketView.from_ticket(ticket)


@router.post(
    "/{org_id}/telemetry/traces/{ingest_id}/finalize",
    status_code=202,
    response_model=TelemetryTraceAcceptedView,
)
async def finalize_org_telemetry_trace_upload(
    org_id: str,
    ingest_id: str,
    client: Client,
    actor: Actor,
) -> TelemetryTraceAcceptedView:
    """Idempotently enqueue durable validation/projection; do not read bytes."""
    await asyncio.to_thread(_authorize_org, client, actor, org_id)
    try:
        record = await asyncio.to_thread(
            TelemetryTraceIngestService(client).accept_signed_upload,
            org_id=org_id,
            ingest_id=ingest_id,
        )
    except TelemetryTraceNotFoundError as error:
        raise ApiError(_TRACE_NOT_FOUND, status_code=404) from error
    return TelemetryTraceAcceptedView.from_record(record)


@router.post(
    "/{org_id}/telemetry/traces/pull",
    status_code=201,
    response_model=TelemetryTraceIngestView,
)
async def pull_org_telemetry_traces(
    org_id: str,
    client: Client,
    actor: Actor,
    body: TelemetryTracePullRequest,
) -> TelemetryTraceIngestView:
    """Pull traces from a live provider/database and land them as telemetry."""
    if body.transport_kind is TraceTransportKind.UPLOAD:
        msg = "transport_kind 'upload' is a file upload; use the upload route"
        raise ApiError(msg, status_code=422)
    await asyncio.to_thread(_authorize_org, client, actor, org_id)
    since = body.since_at.isoformat() if body.since_at is not None else None
    try:
        result = await asyncio.to_thread(
            _pull,
            client,
            org_id=org_id,
            body=body,
            since=since,
            created_by=actor.user_id,
        )
    except ConnectorError as error:
        raise _connector_error(error) from error
    except TraceUploadValidationError as error:
        raise ApiError(str(error), status_code=422) from error
    return TelemetryTraceIngestView.from_result(result)


def _pull(
    client: SupabaseClient,
    *,
    org_id: str,
    body: TelemetryTracePullRequest,
    since: str | None,
    created_by: str,
) -> TelemetryTraceResult:
    """Run one synchronous remote pull off the event loop."""
    return TelemetryTraceIngestService(client).ingest_remote(
        org_id=org_id,
        transport_kind=body.transport_kind,
        source_kind=body.source_kind,
        source_label=body.source_label,
        credential=body.credential,
        config=body.config,
        since=since,
        max_records=body.max_records,
        created_by=created_by,
    )


@router.get("/{org_id}/telemetry/traces", response_model=TelemetryTraceListView)
async def list_org_telemetry_traces(
    org_id: str,
    client: Client,
    actor: Actor,
) -> TelemetryTraceListView:
    """List the org's landed telemetry traces and the total trace count."""
    await asyncio.to_thread(_authorize_org, client, actor, org_id)
    records = await asyncio.to_thread(TraceIngestStore(client).list_org_telemetry, org_id)
    rows = tuple(TelemetryTraceRowView.from_record(record) for record in records)
    return TelemetryTraceListView(
        traces=rows,
        total_ingests=len(rows),
        total_traces=sum(row.trace_count for row in rows),
    )


@router.get(
    "/{org_id}/telemetry/traces/{ingest_id}/spans",
    response_model=TelemetryTraceSpansView,
)
async def list_org_telemetry_trace_spans(
    org_id: str,
    ingest_id: str,
    client: Client,
    actor: Actor,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> TelemetryTraceSpansView:
    """Read one tenant's normalized trace rows directly from ClickHouse."""
    await asyncio.to_thread(_authorize_org, client, actor, org_id)
    receipt = await asyncio.to_thread(TraceIngestStore(client).get_ingest, ingest_id)
    if receipt is None or receipt.org_id != org_id or receipt.world_model_id is not None:
        raise ApiError(_TRACE_NOT_FOUND, status_code=404)
    if receipt.trace_projection_version is None:
        raise ApiError(_TRACE_NOT_FOUND, status_code=404)
    settings = ClickHouseTraceSettings.from_env()
    if settings is None or not settings.read_enabled:
        raise ApiError(_TRACE_READS_DISABLED, status_code=503)
    try:
        raw_rows = await asyncio.to_thread(
            ClickHouseTraceStore(settings).list_ingest,
            org_id=org_id,
            ingest_id=ingest_id,
            projection_version=receipt.trace_projection_version,
            limit=limit,
            offset=offset,
        )
        spans = tuple(TelemetryTraceSpanView.from_row(row) for row in raw_rows)
    except (ClickHouseTraceError, TypeError, ValueError) as error:
        raise ApiError(_TRACE_READ_FAILED, status_code=502) from error
    return TelemetryTraceSpansView(spans=spans, limit=limit, offset=offset)
