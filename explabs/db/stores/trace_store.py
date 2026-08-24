# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Persistence for uploaded OTel trace files.

A ``trace_uploads`` row records one uploaded trace file: where the bytes live
in object storage, its digest, and the ingestion outcome (trace/step counts
once the adapter has parsed it). Uploads may exist before a world model is
chosen, so ``world_model_id`` is nullable.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict

from explabs.db.ids import new_uuid
from explabs.db.repositories import (
    JsonObject,
    SupabaseClient,
    first_row,
    insert_row,
    result_rows,
)
from explabs.db.stores.transitions import now_iso, transition_row

DEFAULT_TRACE_ADAPTER = "otel-genai"


class TraceUploadStatus(StrEnum):
    """Ingestion status of a trace upload (text CHECK constraint)."""

    UPLOADED = "uploaded"
    INGESTED = "ingested"
    FAILED = "failed"


def parse_trace_upload_status(value: object) -> TraceUploadStatus:
    """Parse a persisted trace upload status value.

    Args:
        value: Raw status value from a ``trace_uploads`` row.

    Returns:
        Parsed status.

    Raises:
        ValueError: If the value is not a known status.
    """
    match value:
        case "uploaded":
            return TraceUploadStatus.UPLOADED
        case "ingested":
            return TraceUploadStatus.INGESTED
        case "failed":
            return TraceUploadStatus.FAILED
        case _:
            msg = f"unknown trace upload status value: {value!r}"
            raise ValueError(msg)


class TraceUploadRecord(BaseModel):
    """Typed snapshot of a ``trace_uploads`` row."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    world_model_id: str | None
    filename: str
    storage_path: str
    byte_size: int
    sha256: str
    adapter: str
    trace_count: int | None
    step_count: int | None
    status: TraceUploadStatus
    created_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> TraceUploadRecord:
        """Parse a persisted row, failing loudly on unknown status values."""
        data = dict(row)
        data["status"] = parse_trace_upload_status(data.get("status"))
        return cls.model_validate(data)


# Default cap on list queries; callers page or raise it explicitly instead of
# ever streaming an unbounded table scan through PostgREST.
DEFAULT_LIST_LIMIT = 100


class TraceStore:
    """Persist trace upload rows."""

    def __init__(self, client: SupabaseClient) -> None:
        """Initialize the store.

        Args:
            client: Supabase client.
        """
        self._client = client

    def create_upload(
        self,
        *,
        org_id: str,
        filename: str,
        storage_path: str,
        byte_size: int,
        sha256: str,
        world_model_id: str | None = None,
        adapter: str = DEFAULT_TRACE_ADAPTER,
        trace_count: int | None = None,
        step_count: int | None = None,
    ) -> TraceUploadRecord:
        """Record an uploaded trace file in ``uploaded`` status.

        Args:
            org_id: Owning organization identifier.
            filename: Original upload file name.
            storage_path: Object storage path holding the bytes.
            byte_size: Upload size in bytes.
            sha256: Content digest of the uploaded bytes.
            world_model_id: World model the upload feeds, when already known.
            adapter: Trace ingestion adapter name.
            trace_count: Traces in the file, when already known (catalog
                imports clone their entry's counts; fresh uploads learn
                theirs at ingest).
            step_count: Steps in the file, when already known.

        Returns:
            Created record.
        """
        row = insert_row(
            self._client,
            "trace_uploads",
            {
                "id": new_uuid(),
                "org_id": org_id,
                "world_model_id": world_model_id,
                "filename": filename,
                "storage_path": storage_path,
                "byte_size": byte_size,
                "sha256": sha256,
                "adapter": adapter,
                "trace_count": trace_count,
                "step_count": step_count,
                "status": TraceUploadStatus.UPLOADED.value,
                "created_at": now_iso(),
            },
        )
        return TraceUploadRecord.from_row(row)

    def get(self, upload_id: str) -> TraceUploadRecord:
        """Fetch a trace upload by identifier.

        Args:
            upload_id: Trace upload identifier.

        Returns:
            Current record.

        Raises:
            RepositoryError: If the upload does not exist.
        """
        result = self._client.table("trace_uploads").select("*").eq("id", upload_id).execute()
        return TraceUploadRecord.from_row(first_row(result, context="fetch trace upload"))

    def list_for_world_model(
        self, world_model_id: str, *, limit: int = DEFAULT_LIST_LIMIT
    ) -> tuple[TraceUploadRecord, ...]:
        """List a world model's trace uploads, newest first.

        Args:
            world_model_id: World model identifier.
            limit: Maximum number of rows returned.

        Returns:
            Trace upload records ordered by ``created_at`` descending.
        """
        result = (
            self._client.table("trace_uploads")
            .select("*")
            .eq("world_model_id", world_model_id)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return tuple(TraceUploadRecord.from_row(row) for row in result_rows(result))

    def all_for_world_model(self, world_model_id: str) -> tuple[TraceUploadRecord, ...]:
        """List every trace upload owned by a world model.

        This deliberately has no row limit because deletion must remove every
        object and row, even when the ordinary UI list is capped.

        Args:
            world_model_id: World model identifier.

        Returns:
            All linked trace-upload records, newest first.
        """
        page_size = 1_000
        offset = 0
        records: list[TraceUploadRecord] = []
        while True:
            result = (
                self._client.table("trace_uploads")
                .select("*")
                .eq("world_model_id", world_model_id)
                .order("created_at", desc=True)
                .order("id")
                .range(offset, offset + page_size - 1)
                .execute()
            )
            page = [TraceUploadRecord.from_row(row) for row in result_rows(result)]
            records.extend(page)
            if len(page) < page_size:
                break
            offset += page_size
        return tuple(records)

    def mark_ingested(
        self,
        upload_id: str,
        *,
        trace_count: int,
        step_count: int,
    ) -> TraceUploadRecord:
        """Mark an upload as ingested with the parsed trace/step counts.

        Args:
            upload_id: Trace upload identifier.
            trace_count: Number of traces the adapter parsed.
            step_count: Number of steps the adapter parsed.

        Returns:
            Updated record.

        Raises:
            StateTransitionError: If the upload is not in ``uploaded`` status.
        """
        row = transition_row(
            self._client,
            "trace_uploads",
            upload_id,
            {
                "status": TraceUploadStatus.INGESTED.value,
                "trace_count": trace_count,
                "step_count": step_count,
            },
            allowed_from=(TraceUploadStatus.UPLOADED.value,),
            context="mark trace upload ingested",
        )
        return TraceUploadRecord.from_row(row)

    def mark_failed(self, upload_id: str) -> TraceUploadRecord:
        """Mark an upload as failed to ingest.

        The failure is expressed purely through ``status``; the table carries
        no error column, so callers surface the failure detail elsewhere.

        Args:
            upload_id: Trace upload identifier.

        Returns:
            Updated record.

        Raises:
            StateTransitionError: If the upload is not in ``uploaded`` status.
        """
        row = transition_row(
            self._client,
            "trace_uploads",
            upload_id,
            {"status": TraceUploadStatus.FAILED.value},
            allowed_from=(TraceUploadStatus.UPLOADED.value,),
            context="mark trace upload failed",
        )
        return TraceUploadRecord.from_row(row)
