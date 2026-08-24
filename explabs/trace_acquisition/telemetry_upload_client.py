# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""In-repo HTTP client for the two-phase org telemetry trace upload."""

from __future__ import annotations

import httpx
from pydantic import BaseModel, ConfigDict, Field

from explabs.persistence.object_storage import upload_bytes_to_signed_url
from explabs.trace_acquisition.formats import TraceUploadFormat
from explabs.trace_acquisition.telemetry_ingest import STORAGE_TRACE_CONTENT_TYPE


class TelemetryTraceUploadTicket(BaseModel):
    """Signed-upload ticket returned by the control API."""

    model_config = ConfigDict(frozen=True)

    ingest_id: str
    source_kind: TraceUploadFormat
    source_label: str
    signed_url: str
    token: str
    expires_in: int
    method: str = "PUT"


class TelemetryTraceAccepted(BaseModel):
    """Finalize receipt after durable verification work is enqueued."""

    model_config = ConfigDict(frozen=True)

    ingest_id: str
    status: str
    projection_status: str | None = None
    error_code: str | None = None
    trace_count: int | None = None
    byte_size: int | None = Field(default=None, gt=0)
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


class TelemetryTraceUploadClient:
    """Drive create → raw signed PUT → finalize with an ``xpl_`` org key."""

    def __init__(self, http: httpx.Client, *, api_base_url: str, api_key: str) -> None:
        """Initialize one authenticated control-API client.

        Args:
            http: Shared HTTP client used for control-API calls.
            api_base_url: Public API origin (no trailing path).
            api_key: ``xpl_`` organization key used as the bearer token.
        """
        self._http = http
        self._api_base_url = api_base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {api_key}"}

    def create_upload(
        self,
        *,
        org_id: str,
        source_kind: TraceUploadFormat,
        source_label: str,
    ) -> TelemetryTraceUploadTicket:
        """Reserve an ingest-scoped path and return the signed upload ticket."""
        response = self._http.post(
            f"{self._api_base_url}/api/orgs/{org_id}/telemetry/traces/upload",
            headers=self._headers,
            json={"source_kind": source_kind.value, "source_label": source_label},
        )
        response.raise_for_status()
        return TelemetryTraceUploadTicket.model_validate(response.json())

    def finalize(self, *, org_id: str, ingest_id: str) -> TelemetryTraceAccepted:
        """Enqueue durable worker verification for one reserved ingest."""
        response = self._http.post(
            f"{self._api_base_url}/api/orgs/{org_id}/telemetry/traces/{ingest_id}/finalize",
            headers=self._headers,
        )
        response.raise_for_status()
        return TelemetryTraceAccepted.model_validate(response.json())

    def upload(
        self,
        *,
        org_id: str,
        source_kind: TraceUploadFormat,
        source_label: str,
        content: bytes,
    ) -> TelemetryTraceAccepted:
        """Create a ticket, PUT exact bytes to Storage, then finalize.

        Args:
            org_id: Owning organization identifier.
            source_kind: Declared upload format.
            source_label: Customer-facing label (never a path).
            content: Exact raw bytes to store.

        Returns:
            Accepted finalize receipt. Counts and digest arrive after the worker.
        """
        ticket = self.create_upload(
            org_id=org_id,
            source_kind=source_kind,
            source_label=source_label,
        )
        upload_bytes_to_signed_url(
            ticket.signed_url,
            content,
            content_type=STORAGE_TRACE_CONTENT_TYPE,
        )
        return self.finalize(org_id=org_id, ingest_id=ticket.ingest_id)
