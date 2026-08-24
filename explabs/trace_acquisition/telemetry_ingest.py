# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Org-scoped trace ingestion that lands external traces as platform telemetry.

Unlike Project trace acquisition (``service.py``), which pins a source into an
optimizer Project that can then be prepared and optimized into a router, this
path is deliberately router-free: ingested traces become organization telemetry
only. It writes one ``trace_ingests`` row with ``world_model_id`` left NULL —
the exact column ``TraceIngestStore.latest_for_world_models`` filters on — so no
downstream stage can turn one of these ingests into a world-model / router
build. No optimizer Project, preparation, or optimization job is ever created
here; that is the whole point of the surface.

Two entry points share one landing path:

- ``prepare_signed_upload`` reserves an ingest-scoped Storage path and returns
  a short-lived signed upload ticket. ``accept_signed_upload`` then enqueues
  durable worker validation without reading the object.
- ``ingest_remote`` pulls bounded pages from a live observability provider
  (Braintrust, LangSmith, Langfuse, PostHog, Mastra) or a customer database
  using the same verified connectors the Project flow uses, with the credential
  passed transiently (never persisted by this service).
"""

from __future__ import annotations

import hashlib
import json
import secrets
from enum import StrEnum

import httpx
from pydantic import BaseModel, ConfigDict, Field, JsonValue

from explabs.db.ids import new_uuid
from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.db.stores.trace_ingest_store import TraceIngestRecord, TraceIngestStore
from explabs.persistence.object_storage import (
    SIGNED_UPLOAD_EXPIRES_IN,
    create_signed_upload,
    storage_bucket,
    upload_object_raw,
)
from explabs.trace_acquisition.connectors import (
    HTTP_TIMEOUT_SECONDS,
    AcquisitionErrorCode,
    ConnectorError,
    ConnectorRegistry,
    ConnectorRequest,
    TraceTransportKind,
    connector_registry,
)
from explabs.trace_acquisition.formats import (
    MAX_REMOTE_RECORDS,
    MAX_TRACE_OBJECT_BYTES,
    TraceUploadFormat,
    TraceUploadValidationError,
    canonical_jsonl,
    validate_source_label,
    validate_trace_upload,
)

# Storage keeps raw bytes only; Supabase Storage's MIME registry rejects JSONL
# variants, so the object content type is neutral while the ingest row records
# the caller's declared format.
STORAGE_TRACE_CONTENT_TYPE = "application/octet-stream"
_MAX_REMOTE_PAGES = 100
TRACE_PROJECTION_VERSION = 1
_TRACE_NOT_FOUND = "Telemetry trace ingest not found"


class TelemetryTraceErrorCode(StrEnum):
    """Typed terminal failures for worker-side object verification."""

    OBJECT_MISSING = "object_missing"
    OBJECT_TOO_LARGE = "object_too_large"
    OBJECT_MALFORMED = "object_malformed"
    ABANDONED_UPLOAD = "abandoned_upload"


class TelemetryTraceNotFoundError(LookupError):
    """Router-free ingest is missing or not owned by the calling org."""


class TelemetryTraceObjectError(ValueError):
    """Terminal object verification failure; do not retry the same bytes."""

    def __init__(self, code: TelemetryTraceErrorCode, message: str) -> None:
        """Attach a typed error code to the verification failure."""
        super().__init__(message)
        self.code = code
        self.message = message


class TelemetryTraceResult(BaseModel):
    """Terminal outcome of one telemetry trace ingest (no credential material)."""

    model_config = ConfigDict(frozen=True)

    ingest_id: str
    org_id: str
    source_kind: TraceUploadFormat
    source_label: str
    transport_kind: TraceTransportKind
    trace_count: int
    byte_size: int
    sha256: str
    # Server-internal storage locator; excluded from public API views.
    result_path: str


class TelemetryTraceUploadTicket(BaseModel):
    """Signed-upload reservation for one ingest (path stays server-internal)."""

    model_config = ConfigDict(frozen=True)

    ingest_id: str
    org_id: str
    source_kind: TraceUploadFormat
    source_label: str
    signed_url: str
    token: str
    expires_in: int = Field(default=SIGNED_UPLOAD_EXPIRES_IN, gt=0)
    # Server-internal object locator; excluded from public API views.
    upload_path: str


class VerifiedTraceObject(BaseModel):
    """Worker-computed identity of one downloaded trace object."""

    model_config = ConfigDict(frozen=True)

    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    byte_size: int = Field(gt=0)
    trace_count: int = Field(ge=0)


class TelemetryTraceIngestService:
    """Land external traces as org telemetry without any router build."""

    def __init__(
        self,
        client: SupabaseClient,
        *,
        connectors: ConnectorRegistry | None = None,
    ) -> None:
        """Initialize the service.

        Args:
            client: Supabase client.
            connectors: Optional pre-built remote connector registry. When
                omitted, ``ingest_remote`` builds the production registry around
                a bounded HTTP client for the duration of the pull.
        """
        self._client = client
        self._store = TraceIngestStore(client)
        self._connectors = connectors

    def prepare_signed_upload(
        self,
        *,
        org_id: str,
        source_kind: TraceUploadFormat,
        source_label: str,
        created_by: str | None = None,
    ) -> TelemetryTraceUploadTicket:
        """Reserve an ingest-scoped path and mint a short-lived signed upload.

        The path includes the ingest id plus an unguessable nonce so the
        signed token cannot target another tenant prefix or overwrite a
        known object. Bytes are not read or trusted here.

        Args:
            org_id: Owning organization identifier.
            source_kind: One of the declared upload formats.
            source_label: Customer-facing label (validated; never a path).
            created_by: Acting user id for the audit column.

        Returns:
            Signed URL/token plus the reserved ingest id.

        Raises:
            TraceUploadValidationError: If the label is invalid.
        """
        label = validate_source_label(source_label)
        ingest_id = new_uuid()
        path = (
            f"orgs/{org_id}/telemetry-traces/{source_kind.value}/"
            f"{ingest_id}/{secrets.token_urlsafe(32)}"
        )
        source: JsonObject = {
            "kind": "file",
            "source_kind": source_kind.value,
            "source_label": label,
        }
        ingest = self._store.create_ingest(
            org_id=org_id,
            source=source,
            world_model_id=None,
            connection_id=None,
            upload_path=path,
            created_by=created_by,
            ingest_id=ingest_id,
        )
        ticket = create_signed_upload(self._client, bucket=storage_bucket(), path=path)
        return TelemetryTraceUploadTicket(
            ingest_id=ingest.id,
            org_id=org_id,
            source_kind=source_kind,
            source_label=label,
            signed_url=ticket.signed_url,
            token=ticket.token,
            expires_in=ticket.expires_in,
            upload_path=path,
        )

    def accept_signed_upload(self, *, org_id: str, ingest_id: str) -> TraceIngestRecord:
        """Atomically enqueue worker verification for one reserved upload.

        Idempotent: a second accept of the same ingest returns the current
        receipt without creating a second queue row.

        Args:
            org_id: Owning organization identifier.
            ingest_id: Ingest created by ``prepare_signed_upload``.

        Returns:
            Accepted receipt with pending projection work.

        Raises:
            TelemetryTraceNotFoundError: If the ingest is missing or foreign.
        """
        record = self._store.get_ingest(ingest_id)
        if record is None or record.org_id != org_id or record.world_model_id is not None:
            raise TelemetryTraceNotFoundError(_TRACE_NOT_FOUND)
        return self._store.accept_telemetry_ingest(ingest_id)

    def ingest_remote(
        self,
        *,
        org_id: str,
        transport_kind: TraceTransportKind,
        source_kind: TraceUploadFormat,
        source_label: str,
        credential: str,
        config: JsonObject | None = None,
        since: str | None = None,
        max_records: int = MAX_REMOTE_RECORDS,
        created_by: str | None = None,
    ) -> TelemetryTraceResult:
        """Pull bounded pages from a live provider and land them as telemetry.

        Args:
            org_id: Owning organization identifier.
            transport_kind: A remote transport (never ``upload``).
            source_kind: Format the stored bytes should be interpreted as.
            source_label: Customer-facing label (validated; never a path).
            credential: The provider secret, used transiently and never stored.
            config: Secret-free connector config (host, project, table, ...).
            since: Optional ISO-8601 lower bound honored by supporting transports.
            max_records: Hard cap on records pulled this run.
            created_by: Acting user id for the audit column.

        Returns:
            The terminal ingest result.

        Raises:
            ConnectorError: On any sanitized remote failure.
            TraceUploadValidationError: If the pull returned no usable records.
        """
        label = validate_source_label(source_label)
        request = ConnectorRequest(
            source_format=source_kind,
            config=config or {},
            since=since,
        )
        if self._connectors is not None:
            records = self._collect(
                self._connectors, transport_kind, request, credential, max_records
            )
        else:
            with httpx.Client(timeout=HTTP_TIMEOUT_SECONDS) as http_client:
                registry = connector_registry(http_client)
                records = self._collect(registry, transport_kind, request, credential, max_records)
        content = canonical_jsonl(records)
        source: JsonObject = {
            "kind": "provider",
            "provider": transport_kind.value,
            "source_kind": source_kind.value,
            "source_label": label,
            "config": dict(config or {}),
        }
        return self._land(
            org_id=org_id,
            source_kind=source_kind,
            source_label=label,
            transport_kind=transport_kind,
            content=content,
            trace_count=len(records),
            source=source,
            created_by=created_by,
        )

    def _collect(
        self,
        registry: ConnectorRegistry,
        transport_kind: TraceTransportKind,
        request: ConnectorRequest,
        credential: str,
        max_records: int,
    ) -> list[JsonValue]:
        """Collect bounded, deduplicated pages from one remote transport."""
        connector = registry.get(transport_kind)
        records: list[JsonValue] = []
        seen_records: set[str] = set()
        seen_cursors: set[str] = set()
        cursor: str | None = None
        fetched = 0
        canonical_byte_size = 0
        for _page in range(_MAX_REMOTE_PAGES):
            remaining = max_records - fetched
            if remaining <= 0:
                break
            batch = connector.fetch_page(
                request,
                credential=credential,
                cursor=cursor,
                limit=remaining,
            )
            if len(batch.records) > remaining or (
                not batch.records and batch.next_cursor is not None
            ):
                raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE)
            fetched += len(batch.records)
            for record in batch.records:
                identity = _canonical_record(record)
                if identity in seen_records:
                    continue
                canonical_byte_size += len(identity.encode()) + 1
                if canonical_byte_size > MAX_TRACE_OBJECT_BYTES:
                    raise ConnectorError(AcquisitionErrorCode.OBJECT_TOO_LARGE)
                seen_records.add(identity)
                records.append(record)
            next_cursor = batch.next_cursor
            if next_cursor is None or fetched >= max_records:
                break
            if next_cursor == cursor or next_cursor in seen_cursors:
                raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE)
            seen_cursors.add(next_cursor)
            cursor = next_cursor
        return records

    def _land(
        self,
        *,
        org_id: str,
        source_kind: TraceUploadFormat,
        source_label: str,
        transport_kind: TraceTransportKind,
        content: bytes,
        trace_count: int,
        source: JsonObject,
        created_by: str | None,
    ) -> TelemetryTraceResult:
        """Store exact bytes once and record a done, router-free ingest row."""
        digest = hashlib.sha256(content, usedforsecurity=False).hexdigest()
        path = f"orgs/{org_id}/telemetry-traces/{source_kind.value}/{digest}"
        upload_object_raw(
            self._client,
            bucket=storage_bucket(),
            path=path,
            data=content,
            content_type=STORAGE_TRACE_CONTENT_TYPE,
        )
        # world_model_id is deliberately NULL: this ingest is telemetry, never a
        # router build input. connection_id is NULL because the credential is
        # transient here (not a stored Vault connection).
        ingest = self._store.create_ingest(
            org_id=org_id,
            source=source,
            world_model_id=None,
            connection_id=None,
            upload_path=path,
            created_by=created_by,
        )
        self._store.complete_telemetry_ingest(
            ingest.id,
            result_path=path,
            trace_count=trace_count,
            byte_size=len(content),
            object_sha256=digest,
            projection_version=TRACE_PROJECTION_VERSION,
        )
        return TelemetryTraceResult(
            ingest_id=ingest.id,
            org_id=org_id,
            source_kind=source_kind,
            source_label=source_label,
            transport_kind=transport_kind,
            trace_count=trace_count,
            byte_size=len(content),
            sha256=digest,
            result_path=path,
        )


def verify_stored_trace_object(
    content: bytes | None,
    *,
    expected_sha256: str | None = None,
    expected_byte_size: int | None = None,
) -> VerifiedTraceObject:
    """Verify one downloaded object. Never treats caller hash/size as proof.

    Args:
        content: Exact bytes from Storage, or ``None`` when the object is absent.
        expected_sha256: Previously recorded digest to detect corruption.
        expected_byte_size: Previously recorded size to detect truncation.

    Returns:
        Worker-computed digest, size, and conservative record count.

    Raises:
        TelemetryTraceObjectError: Missing, oversized, or malformed bytes.
        ValueError: Recorded identity does not match the downloaded bytes.
    """
    if content is None:
        raise TelemetryTraceObjectError(
            TelemetryTraceErrorCode.OBJECT_MISSING,
            "Stored trace object was not found",
        )
    if len(content) > MAX_TRACE_OBJECT_BYTES:
        raise TelemetryTraceObjectError(
            TelemetryTraceErrorCode.OBJECT_TOO_LARGE,
            f"Stored trace object exceeds the {MAX_TRACE_OBJECT_BYTES} byte limit",
        )
    try:
        validated = validate_trace_upload(content, content_type=STORAGE_TRACE_CONTENT_TYPE)
    except TraceUploadValidationError as error:
        raise TelemetryTraceObjectError(
            TelemetryTraceErrorCode.OBJECT_MALFORMED,
            str(error),
        ) from error
    digest = hashlib.sha256(content, usedforsecurity=False).hexdigest()
    byte_size = len(content)
    if expected_byte_size is not None and byte_size != expected_byte_size:
        msg = "Stored trace object size does not match its receipt"
        raise ValueError(msg)
    if expected_sha256 is not None and digest != expected_sha256:
        msg = "Stored trace object digest does not match its receipt"
        raise ValueError(msg)
    return VerifiedTraceObject(
        sha256=digest,
        byte_size=byte_size,
        trace_count=validated.record_count_estimate,
    )


def _canonical_record(record: JsonValue) -> str:
    """Return a stable in-memory identity for cross-page deduplication."""
    try:
        return json.dumps(
            record,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (RecursionError, ValueError) as error:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE) from error
