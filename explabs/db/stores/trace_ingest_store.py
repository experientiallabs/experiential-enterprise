# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Persistence for streaming trace ingests and org trace-source connections.

A ``trace_ingests`` row is the durable handle behind one D-INGEST run: the
sanitized source (credential fields stripped before the row is written), the
storage paths, and the terminal outcome so a stream reconnect can replay it.

A ``trace_connections`` row is one org's stored connection to an observability
provider or database. The credential itself lives in Supabase Vault: it enters
through the ``upsert_trace_connection`` RPC and leaves only through
``release_trace_connection_credential`` at ingest time, so this store never
holds a credential byte outside those two service-role calls.
"""

from __future__ import annotations

from collections.abc import Sequence
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
from explabs.db.stores.transitions import now_iso


class TraceIngestStatus(StrEnum):
    """Lifecycle of one ingest run (text CHECK constraint)."""

    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"


class TraceProjectionStatus(StrEnum):
    """Lifecycle of the rebuildable ClickHouse trace projection."""

    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"


class TraceConnectionRecord(BaseModel):
    """Typed snapshot of a ``trace_connections`` row (no credential material)."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    kind: str
    config: JsonObject
    credential_last4: str | None = None


class TraceIngestRecord(BaseModel):
    """Typed snapshot of a ``trace_ingests`` row."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    world_model_id: str | None = None
    connection_id: str | None = None
    source: JsonObject
    status: TraceIngestStatus
    upload_path: str | None = None
    result_path: str | None = None
    trace_upload_id: str | None = None
    trace_count: int | None = None
    step_count: int | None = None
    error_message: str | None = None
    error_code: str | None = None
    object_sha256: str | None = None
    byte_size: int | None = None
    trace_projection_status: TraceProjectionStatus | None = None
    trace_projection_version: int | None = None
    trace_projected_rows: int | None = None
    trace_projected_at: str | None = None
    trace_projection_error_code: str | None = None

    @classmethod
    def from_row(cls, row: JsonObject) -> TraceIngestRecord:
        """Parse a persisted row, failing loudly on unknown status values."""
        data = dict(row)
        data["status"] = TraceIngestStatus(str(data.get("status")))
        projection_status = data.get("trace_projection_status")
        if projection_status is not None:
            data["trace_projection_status"] = TraceProjectionStatus(str(projection_status))
        return cls.model_validate(data)


class TraceIngestStore:
    """Persist trace ingest rows and org trace-source connections."""

    def __init__(self, client: SupabaseClient) -> None:
        """Initialize the store.

        Args:
            client: Supabase client.
        """
        self._client = client

    # --- connections ----------------------------------------------------------------------------

    def upsert_connection(
        self,
        *,
        org_id: str,
        kind: str,
        config: JsonObject,
        credential: str,
        actor: str | None = None,
    ) -> TraceConnectionRecord:
        """Create or rotate the org's stored connection for one source kind.

        Args:
            org_id: Owning organization identifier.
            kind: Source kind (provider name or ``postgres``).
            config: Non-secret connection config (host, project, ...).
            credential: The secret (API key or DSN); goes straight to Vault.
            actor: Acting user id for audit columns.

        Returns:
            The connection record (credential excluded by construction).
        """
        result = self._client.rpc(
            "upsert_trace_connection",
            {
                "in_org_id": org_id,
                "in_kind": kind,
                "in_config": config,
                "in_secret": credential,
                "in_actor": actor,
            },
        ).execute()
        row = first_row(result, context=f"upsert_trace_connection for org {org_id}")
        return TraceConnectionRecord.model_validate(row)

    def find_connection(self, org_id: str, kind: str) -> TraceConnectionRecord | None:
        """The org's stored connection for a source kind, when one exists."""
        result = (
            self._client.table("trace_connections")
            .select("id, org_id, kind, config, credential_last4")
            .eq("org_id", org_id)
            .eq("kind", kind)
            .execute()
        )
        rows = result_rows(result)
        if not rows:
            return None
        return TraceConnectionRecord.model_validate(rows[0])

    def list_connections(self, org_id: str) -> tuple[TraceConnectionRecord, ...]:
        """List the org's stored trace connections without credential material.

        Args:
            org_id: Owning organization identifier.

        Returns:
            Connections ordered by kind. Credential values remain in Vault and
            are never selected by this query.
        """
        result = (
            self._client.table("trace_connections")
            .select("id, org_id, kind, config, credential_last4")
            .eq("org_id", org_id)
            .order("kind")
            .execute()
        )
        return tuple(TraceConnectionRecord.model_validate(row) for row in result_rows(result))

    def release_credential(self, connection_id: str) -> str:
        """Decrypt one connection's credential for an ingest run (stamps last_used_at)."""
        result = self._client.rpc(
            "release_trace_connection_credential",
            {"in_connection_id": connection_id},
        ).execute()
        row = first_row(result, context=f"release credential for connection {connection_id}")
        credential = row.get("credential")
        if isinstance(credential, str) and credential:
            return credential
        msg = f"trace connection credential release returned no value: {connection_id}"
        raise ValueError(msg)

    # --- ingests --------------------------------------------------------------------------------

    def create_ingest(
        self,
        *,
        org_id: str,
        source: JsonObject,
        world_model_id: str | None = None,
        connection_id: str | None = None,
        upload_path: str | None = None,
        created_by: str | None = None,
        ingest_id: str | None = None,
    ) -> TraceIngestRecord:
        """Record one requested ingest in ``pending`` status.

        Args:
            org_id: Owning organization identifier.
            source: The requested source with credential fields ALREADY stripped.
            world_model_id: World model the corpus should chain into, if any.
            connection_id: Stored connection backing a provider/database source.
            upload_path: Storage path of the uploaded file for file sources.
            created_by: Acting user id.
            ingest_id: Caller-chosen id when the storage path must include it.

        Returns:
            Created record.
        """
        row = insert_row(
            self._client,
            "trace_ingests",
            {
                "id": ingest_id or new_uuid(),
                "org_id": org_id,
                "world_model_id": world_model_id,
                "connection_id": connection_id,
                "source": source,
                "status": TraceIngestStatus.PENDING.value,
                "upload_path": upload_path,
                "created_by": created_by,
                "created_at": now_iso(),
                "updated_at": now_iso(),
            },
        )
        return TraceIngestRecord.from_row(row)

    def get_ingest(self, ingest_id: str) -> TraceIngestRecord | None:
        """Load one ingest row by id (None when absent)."""
        result = self._client.table("trace_ingests").select("*").eq("id", ingest_id).execute()
        rows = result_rows(result)
        if not rows:
            return None
        return TraceIngestRecord.from_row(rows[0])

    def latest_for_world_models(
        self, world_model_ids: Sequence[str], *, org_id: str
    ) -> dict[str, TraceIngestRecord]:
        """Newest ingest row per world model, for pipeline-stage derivation.

        Rows come back newest-first, so the first row seen per world model wins;
        world models with no ingest rows are simply absent from the result.
        Scoped to one org so the global ordering cannot be starved past the
        PostgREST row cap by other tenants' rows.
        """
        if not world_model_ids:
            return {}
        result = (
            self._client.table("trace_ingests")
            .select("*")
            .eq("org_id", org_id)
            .in_("world_model_id", list(world_model_ids))
            .order("created_at", desc=True)
            .execute()
        )
        latest: dict[str, TraceIngestRecord] = {}
        for row in result_rows(result):
            record = TraceIngestRecord.from_row(row)
            if record.world_model_id is not None and record.world_model_id not in latest:
                latest[record.world_model_id] = record
        return latest

    def list_org_telemetry(self, org_id: str, *, limit: int = 200) -> tuple[TraceIngestRecord, ...]:
        """Newest router-free telemetry ingests for one org.

        Scoped to rows whose ``world_model_id`` is NULL: those are the traces
        ingested as organization telemetry only, never chained into a world
        model / router build. This is the read behind the CLI verify-count and
        the org telemetry-traces surface.

        Args:
            org_id: Owning organization identifier.
            limit: Maximum rows to return, newest first.

        Returns:
            Telemetry ingest rows ordered newest first.
        """
        result = (
            self._client.table("trace_ingests")
            .select("*")
            .eq("org_id", org_id)
            .is_("world_model_id", None)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return tuple(TraceIngestRecord.from_row(row) for row in result_rows(result))

    def claim_pending(self, ingest_id: str) -> bool:
        """Atomically flip a pending ingest to ``running``.

        The status filter makes the claim a compare-and-set: of two concurrent stream
        requests, exactly one observes the ``pending`` row and wins; the loser gets False
        (and the route turns that into a 409) instead of a duplicate run.
        """
        result = (
            self._client.table("trace_ingests")
            .update({"status": TraceIngestStatus.RUNNING.value, "updated_at": now_iso()})
            .eq("id", ingest_id)
            .eq("status", TraceIngestStatus.PENDING.value)
            .execute()
        )
        return bool(result_rows(result))

    def mark_done(
        self,
        ingest_id: str,
        *,
        result_path: str,
        trace_count: int,
        step_count: int,
        trace_upload_id: str | None,
    ) -> None:
        """Record a successful run's outcome."""
        self._update(
            ingest_id,
            {
                "status": TraceIngestStatus.DONE.value,
                "result_path": result_path,
                "trace_count": trace_count,
                "step_count": step_count,
                "trace_upload_id": trace_upload_id,
            },
        )

    def complete_telemetry_ingest(
        self,
        ingest_id: str,
        *,
        result_path: str,
        trace_count: int,
        byte_size: int,
        object_sha256: str,
        projection_version: int = 1,
    ) -> TraceIngestRecord:
        """Atomically complete a router-free ingest and enqueue projection.

        Args:
            ingest_id: Router-free trace ingest identifier.
            result_path: Canonical immutable object path in Storage.
            trace_count: Conservative source record count.
            byte_size: Exact raw object size.
            object_sha256: SHA-256 digest of the exact object bytes.
            projection_version: Normalization contract version to materialize.

        Returns:
            Completed ingest receipt with pending projection state.
        """
        result = self._client.rpc(
            "complete_telemetry_trace_ingest",
            {
                "in_ingest_id": ingest_id,
                "in_result_path": result_path,
                "in_trace_count": trace_count,
                "in_byte_size": byte_size,
                "in_object_sha256": object_sha256,
                "in_projection_version": projection_version,
            },
        ).execute()
        row = first_row(result, context=f"complete telemetry trace ingest {ingest_id}")
        return TraceIngestRecord.from_row(row)

    def accept_telemetry_ingest(self, ingest_id: str) -> TraceIngestRecord:
        """Idempotently enqueue durable validation/projection for one upload.

        Args:
            ingest_id: Router-free ingest whose object may already be in Storage.

        Returns:
            Current receipt after the accept transaction.
        """
        result = self._client.rpc(
            "accept_telemetry_trace_ingest",
            {"in_ingest_id": ingest_id},
        ).execute()
        row = first_row(result, context=f"accept telemetry trace ingest {ingest_id}")
        return TraceIngestRecord.from_row(row)

    def record_verified_object(
        self,
        ingest_id: str,
        *,
        claim_token: str,
        object_sha256: str,
        byte_size: int,
        trace_count: int,
    ) -> TraceIngestRecord:
        """Persist worker-computed object identity while the claim is live.

        Args:
            ingest_id: Claimed ingest identifier.
            claim_token: Live projection claim token.
            object_sha256: SHA-256 of the downloaded object bytes.
            byte_size: Exact downloaded byte count.
            trace_count: Conservative record-count estimate from those bytes.

        Returns:
            Receipt carrying the verified object metadata.
        """
        result = self._client.rpc(
            "record_telemetry_trace_object",
            {
                "in_ingest_id": ingest_id,
                "in_claim_token": claim_token,
                "in_object_sha256": object_sha256,
                "in_byte_size": byte_size,
                "in_trace_count": trace_count,
            },
        ).execute()
        row = first_row(result, context=f"record telemetry trace object {ingest_id}")
        return TraceIngestRecord.from_row(row)

    def fail_telemetry_ingest(
        self,
        ingest_id: str,
        *,
        claim_token: str,
        error_code: str,
        message: str,
    ) -> bool:
        """Record a terminal validation failure and drop its projection job."""
        return self._scalar_bool(
            "fail_telemetry_trace_ingest",
            {
                "in_ingest_id": ingest_id,
                "in_claim_token": claim_token,
                "in_error_code": error_code,
                "in_error_message": message,
            },
        )

    def claim_abandoned_uploads(
        self,
        *,
        older_than_seconds: int,
        limit: int = 16,
    ) -> tuple[TraceIngestRecord, ...]:
        """Claim abandoned or failed upload rows that still own Storage objects."""
        result = self._client.rpc(
            "claim_abandoned_telemetry_trace_ingests",
            {
                "in_older_than_seconds": older_than_seconds,
                "in_limit": limit,
            },
        ).execute()
        return tuple(TraceIngestRecord.from_row(row) for row in result_rows(result))

    def ack_abandoned_upload(self, ingest_id: str, *, delete_row: bool) -> bool:
        """Clear object locators after Storage deletion; optionally drop the row."""
        return self._scalar_bool(
            "ack_abandoned_telemetry_trace_ingest",
            {"in_ingest_id": ingest_id, "in_delete_row": delete_row},
        )

    def mark_error(self, ingest_id: str, *, message: str, code: str | None) -> None:
        """Record a failed run's outcome."""
        self._update(
            ingest_id,
            {
                "status": TraceIngestStatus.ERROR.value,
                "error_message": message,
                "error_code": code,
            },
        )

    def _update(self, ingest_id: str, changes: JsonObject) -> None:
        payload = {**changes, "updated_at": now_iso()}
        self._client.table("trace_ingests").update(payload).eq("id", ingest_id).execute()

    def _scalar_bool(self, name: str, params: JsonObject) -> bool:
        """Execute a scalar boolean RPC and reject ambiguous response shapes."""
        result = self._client.rpc(name, params).execute()
        data: object = result.data
        if not isinstance(data, bool):
            msg = f"{name} returned a non-boolean payload"
            raise TypeError(msg)
        return data
