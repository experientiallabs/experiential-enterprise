# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Persistence for built world-model bundle metadata.

Bundle bytes are canonical in Supabase Storage; an ``artifacts`` row is the
durable handle recording where a bundle lives (``storage_bucket`` +
``storage_path``) plus integrity metadata (``byte_size``, ``sha256``).
``world_models.artifact_id`` points at the row for a model's current bundle,
and ``EXPLABS_WMH_ROOT`` is only a host-local cache of unpacked bundles.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict

from explabs.db.ids import new_uuid
from explabs.db.repositories import (
    DeleteCapableQuery,
    JsonObject,
    RepositoryError,
    SupabaseClient,
    first_row,
    insert_row,
    result_rows,
)
from explabs.db.stores.transitions import now_iso

DEFAULT_STORAGE_BUCKET = "explabs-artifacts"


class ArtifactKind(StrEnum):
    """Kind of platform asset an ``artifacts`` row describes.

    The column is plain text in Postgres so new kinds land without a
    migration; the Python boundary stays exhaustive over the kinds the
    platform actually writes.
    """

    WORLD_MODEL_BUNDLE = "world_model_bundle"
    # Pre-pivot optimizer facet embeddings. Nothing writes this kind anymore;
    # it survives so rows recorded before the endpoint pivot keep parsing.
    TASK_EMBEDDINGS = "task_embeddings"


def parse_artifact_kind(value: object) -> ArtifactKind:
    """Parse a persisted ``artifacts.kind`` value.

    Args:
        value: Raw kind value from an ``artifacts`` row.

    Returns:
        Parsed kind.

    Raises:
        ValueError: If the value is not a known kind.
    """
    match value:
        case "world_model_bundle":
            return ArtifactKind.WORLD_MODEL_BUNDLE
        case "task_embeddings":
            return ArtifactKind.TASK_EMBEDDINGS
        case _:
            msg = f"unknown artifact kind value: {value!r}"
            raise ValueError(msg)


class ArtifactRecord(BaseModel):
    """Typed snapshot of an ``artifacts`` row."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    world_model_id: str | None
    kind: ArtifactKind
    storage_bucket: str
    storage_path: str
    byte_size: int
    sha256: str
    created_at: str
    agent_opt_run_id: str | None = None

    @classmethod
    def from_row(cls, row: JsonObject) -> ArtifactRecord:
        """Parse a persisted row, failing loudly on unknown kind values."""
        data = dict(row)
        data["kind"] = parse_artifact_kind(data.get("kind"))
        return cls.model_validate(data)


class ArtifactStore:
    """Persist built-bundle metadata rows."""

    def __init__(self, client: SupabaseClient) -> None:
        """Initialize the store.

        Args:
            client: Supabase client.
        """
        self._client = client

    def create(
        self,
        *,
        org_id: str,
        kind: ArtifactKind,
        storage_path: str,
        byte_size: int,
        sha256: str,
        world_model_id: str | None = None,
        storage_bucket: str = DEFAULT_STORAGE_BUCKET,
        artifact_id: str | None = None,
    ) -> ArtifactRecord:
        """Record one stored bundle's metadata.

        The caller uploads the bytes to object storage first; this row is the
        durable pointer the rest of the platform links to.

        Args:
            org_id: Owning organization identifier.
            kind: Artifact kind.
            storage_path: Object path within the bucket, unique platform-wide.
            byte_size: Uploaded payload size in bytes.
            sha256: Content digest of the uploaded bytes.
            world_model_id: World model the bundle belongs to, if any.
            storage_bucket: Storage bucket holding the bytes.
            artifact_id: Pre-generated row identifier so callers can derive
                the canonical id-bearing storage path before the upload;
                defaults to a fresh uuid.

        Returns:
            Created record.

        Raises:
            ValueError: If ``byte_size`` is negative or ``sha256``/
                ``storage_path`` is empty.
        """
        if byte_size < 0:
            msg = f"artifact byte_size must be >= 0, got {byte_size}"
            raise ValueError(msg)
        if not storage_path:
            msg = "artifact storage_path is required"
            raise ValueError(msg)
        if not sha256:
            msg = "artifact sha256 is required"
            raise ValueError(msg)
        row = insert_row(
            self._client,
            "artifacts",
            {
                "id": artifact_id if artifact_id is not None else new_uuid(),
                "org_id": org_id,
                "world_model_id": world_model_id,
                # Only pre-pivot optimizer task-embeddings artifacts carry an
                # agent_opt_run_id; every new artifact writes the column null.
                "agent_opt_run_id": None,
                "kind": kind.value,
                "storage_bucket": storage_bucket,
                "storage_path": storage_path,
                "byte_size": byte_size,
                "sha256": sha256,
                "created_at": now_iso(),
            },
        )
        return ArtifactRecord.from_row(row)

    def get(self, artifact_id: str) -> ArtifactRecord:
        """Fetch an artifact by identifier.

        Args:
            artifact_id: Artifact identifier.

        Returns:
            Current record.

        Raises:
            RepositoryError: If the artifact does not exist.
        """
        result = self._client.table("artifacts").select("*").eq("id", artifact_id).execute()
        return ArtifactRecord.from_row(first_row(result, context="fetch artifact"))

    def delete(self, artifact_id: str) -> None:
        """Delete an artifact row (compensation for a failed multi-step write).

        Args:
            artifact_id: Artifact identifier.

        Raises:
            RepositoryError: If the client cannot delete or no row was deleted.
        """
        query = self._client.table("artifacts")
        if not isinstance(query, DeleteCapableQuery):
            msg = "Supabase query builder does not support delete"
            raise RepositoryError(msg)
        result = query.delete().eq("id", artifact_id).execute()
        if not result.data:
            msg = f"artifact {artifact_id} not found"
            raise RepositoryError(msg)

    def get_for_world_model(self, world_model_id: str) -> ArtifactRecord | None:
        """Fetch a world model's newest bundle artifact, if it has one.

        Args:
            world_model_id: World model identifier.

        Returns:
            Newest linked record by ``created_at``, or ``None`` when the
            model has no built bundle yet.
        """
        result = (
            self._client.table("artifacts")
            .select("*")
            .eq("world_model_id", world_model_id)
            # Task-embeddings artifacts also link to the model; the kind
            # filter keeps this the newest BUNDLE, as the contract promises.
            .eq("kind", ArtifactKind.WORLD_MODEL_BUNDLE.value)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = result_rows(result)
        if not rows:
            return None
        return ArtifactRecord.from_row(rows[0])

    def all_for_world_model(self, world_model_id: str) -> tuple[ArtifactRecord, ...]:
        """List every artifact owned by a world model.

        This deliberately has no row limit: destructive cleanup must not leak
        older bundles when a model has been rebuilt or pushed many times.

        Args:
            world_model_id: World model identifier.

        Returns:
            All linked artifact records, newest first.
        """
        page_size = 1_000
        offset = 0
        records: list[ArtifactRecord] = []
        while True:
            result = (
                self._client.table("artifacts")
                .select("*")
                .eq("world_model_id", world_model_id)
                .order("created_at", desc=True)
                .order("id")
                .range(offset, offset + page_size - 1)
                .execute()
            )
            page = [ArtifactRecord.from_row(row) for row in result_rows(result)]
            records.extend(page)
            if len(page) < page_size:
                break
            offset += page_size
        return tuple(records)
