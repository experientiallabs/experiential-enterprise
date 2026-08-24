# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Leased Postgres queue access for immutable trace-object projections."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from explabs.db.repositories import JsonObject, SupabaseClient, result_rows


class TraceProjectionJob(BaseModel):
    """One claimed immutable-object projection job."""

    model_config = ConfigDict(frozen=True)

    ingest_id: str
    org_id: str
    result_path: str | None = None
    object_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    byte_size: int | None = Field(default=None, gt=0)
    source: JsonObject
    received_at: str
    projection_version: int = Field(gt=0)
    projection_attempt: int = Field(gt=0)
    claim_token: str


class TraceDeletionJob(BaseModel):
    """One claimed tenant-scoped ClickHouse erasure job."""

    model_config = ConfigDict(frozen=True)

    ingest_id: str
    org_id: str
    claim_token: str


class TraceProjectionStore:
    """Claim, acknowledge, retry, and backfill trace projections."""

    def __init__(self, client: SupabaseClient) -> None:
        """Initialize with a service-role Supabase client."""
        self._client = client

    def claim(
        self,
        worker_id: str,
        *,
        limit: int = 1,
        lease_seconds: int = 120,
    ) -> tuple[TraceProjectionJob, ...]:
        """Lease oldest eligible objects through ``FOR UPDATE SKIP LOCKED``."""
        result = self._client.rpc(
            "claim_trace_clickhouse_projection",
            {
                "in_worker_id": worker_id,
                "in_limit": limit,
                "in_lease_seconds": lease_seconds,
            },
        ).execute()
        return tuple(TraceProjectionJob.model_validate(row) for row in result_rows(result))

    def ack(self, job: TraceProjectionJob, *, projected_rows: int) -> bool:
        """Set terminal projection metadata only while the claim token is live."""
        return self._scalar_bool(
            "ack_trace_clickhouse_projection",
            {
                "in_ingest_id": job.ingest_id,
                "in_claim_token": job.claim_token,
                "in_projected_rows": projected_rows,
            },
        )

    def nack(
        self,
        job: TraceProjectionJob,
        *,
        retry_seconds: int,
        error_code: str,
    ) -> bool:
        """Release one failed claim with a sanitized delayed-retry code."""
        return self._scalar_bool(
            "nack_trace_clickhouse_projection",
            {
                "in_ingest_id": job.ingest_id,
                "in_claim_token": job.claim_token,
                "in_retry_seconds": retry_seconds,
                "in_error_code": error_code,
            },
        )

    def enqueue_backfill(self, *, limit: int = 1000, projection_version: int = 1) -> int:
        """Enqueue missing or stale receipts without reading their raw bytes."""
        result = self._client.rpc(
            "enqueue_trace_clickhouse_backfill",
            {
                "in_limit": limit,
                "in_projection_version": projection_version,
            },
        ).execute()
        data: object = result.data
        if isinstance(data, bool) or not isinstance(data, int):
            msg = "enqueue_trace_clickhouse_backfill returned a non-integer payload"
            raise TypeError(msg)
        return data

    def claim_deletions(
        self,
        worker_id: str,
        *,
        limit: int = 16,
        lease_seconds: int = 120,
    ) -> tuple[TraceDeletionJob, ...]:
        """Lease oldest eligible ClickHouse erasures before new projections."""
        result = self._client.rpc(
            "claim_trace_clickhouse_deletion",
            {
                "in_worker_id": worker_id,
                "in_limit": limit,
                "in_lease_seconds": lease_seconds,
            },
        ).execute()
        return tuple(TraceDeletionJob.model_validate(row) for row in result_rows(result))

    def ack_deletion(self, job: TraceDeletionJob) -> bool:
        """Remove one erasure job only while its claim token is live."""
        return self._scalar_bool(
            "ack_trace_clickhouse_deletion",
            {"in_ingest_id": job.ingest_id, "in_claim_token": job.claim_token},
        )

    def nack_deletion(
        self,
        job: TraceDeletionJob,
        *,
        retry_seconds: int,
        error_code: str,
    ) -> bool:
        """Release one failed erasure for a delayed retry."""
        return self._scalar_bool(
            "nack_trace_clickhouse_deletion",
            {
                "in_ingest_id": job.ingest_id,
                "in_claim_token": job.claim_token,
                "in_retry_seconds": retry_seconds,
                "in_error_code": error_code,
            },
        )

    def _scalar_bool(self, name: str, params: JsonObject) -> bool:
        """Execute a scalar boolean RPC and reject ambiguous response shapes."""
        result = self._client.rpc(name, params).execute()
        data: object = result.data
        if not isinstance(data, bool):
            msg = f"{name} returned a non-boolean payload"
            raise TypeError(msg)
        return data
