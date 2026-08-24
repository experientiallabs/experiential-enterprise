# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Durable, retryable cleanup for external resource objects.

Database cascades and Storage/E2B deletion cannot share one transaction.
Resource deletion therefore stages an outbox row before deleting relational
metadata. The request attempts external cleanup immediately, while the API
lifespan reaper retries any row that survives a transient failure or process
exit.
"""

from __future__ import annotations

import logging
import os
from enum import StrEnum

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import (
    DeleteCapableQuery,
    JsonObject,
    RemoveCapableStorageBucket,
    RepositoryError,
    SupabaseClient,
    first_row,
    result_rows,
    update_by_id,
)
from explabs.db.stores.transitions import now_iso

logger = logging.getLogger(__name__)

_CLEANUP_PAGE_SIZE = 1_000
_STORAGE_DELETE_BATCH_SIZE = 1_000
E2B_API_KEY_ENV = "E2B_API_KEY"


class StorageCleanupResourceType(StrEnum):
    """Root resource whose existence gates a staged cleanup job.

    ``AGENT`` survives only so outbox rows staged before the endpoint pivot
    still parse and drain; no code stages new agent jobs.
    """

    WORLD_MODEL = "world_model"
    AGENT = "agent"


class StorageCleanupState(StrEnum):
    """Lifecycle of one durable Storage cleanup request."""

    STAGED = "staged"
    PENDING = "pending"


class StorageCleanupObject(BaseModel):
    """One exact Supabase Storage object owned by a deleted resource."""

    model_config = ConfigDict(frozen=True)

    bucket: str
    path: str


class StorageCleanupJob(BaseModel):
    """Typed snapshot of a ``storage_cleanup_jobs`` outbox row."""

    model_config = ConfigDict(frozen=True)

    id: str
    resource_type: StorageCleanupResourceType
    resource_id: str
    state: StorageCleanupState
    objects: tuple[StorageCleanupObject, ...]
    sandbox_ids: tuple[str, ...]
    attempt_count: int
    last_error: str | None
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> StorageCleanupJob:
        """Validate a raw cleanup-job row at the repository boundary."""
        return cls.model_validate(row)


def stage_world_model_cleanup(
    client: SupabaseClient,
    world_model_id: str,
    paths_by_bucket: dict[str, tuple[str, ...]],
    *,
    sandbox_ids: tuple[str, ...] = (),
) -> StorageCleanupJob | None:
    """Persist the complete Storage cleanup plan before deleting a world model.

    The row starts ``staged``. Reapers never process a staged job while its
    world model still exists, so a failed relational delete cannot remove live
    bytes. If the process exits after the relational delete, the reaper sees
    that the model is absent and safely promotes the job on its next pass.

    Args:
        client: Service-role Supabase client.
        world_model_id: Root row that owns the objects.
        paths_by_bucket: Exact, de-duplicated object paths grouped by bucket.
        sandbox_ids: Persistent E2B workspaces owned through hosted agents.

    Returns:
        Persisted job, or ``None`` when the model owns no external objects.
    """
    return _stage_cleanup(
        client,
        resource_type=StorageCleanupResourceType.WORLD_MODEL,
        resource_id=world_model_id,
        paths_by_bucket=paths_by_bucket,
        sandbox_ids=sandbox_ids,
    )


def _stage_cleanup(
    client: SupabaseClient,
    *,
    resource_type: StorageCleanupResourceType,
    resource_id: str,
    paths_by_bucket: dict[str, tuple[str, ...]],
    sandbox_ids: tuple[str, ...] = (),
) -> StorageCleanupJob | None:
    """Insert one independent outbox row for an exact external object set."""
    objects = [
        StorageCleanupObject(bucket=bucket, path=path)
        for bucket in sorted(paths_by_bucket)
        for path in paths_by_bucket[bucket]
    ]
    if not objects and not sandbox_ids:
        return None
    now = now_iso()
    result = (
        client.table("storage_cleanup_jobs")
        .insert(
            {
                "resource_type": resource_type.value,
                "resource_id": resource_id,
                "state": StorageCleanupState.STAGED.value,
                "objects": [item.model_dump(mode="json") for item in objects],
                "sandbox_ids": list(dict.fromkeys(sandbox_ids)),
                "attempt_count": 0,
                "last_error": None,
                "created_at": now,
                "updated_at": now,
            }
        )
        .execute()
    )
    return StorageCleanupJob.from_row(first_row(result, context="stage Storage cleanup"))


def process_storage_cleanup_job(
    client: SupabaseClient,
    job: StorageCleanupJob,
    *,
    deleted_resource_confirmed: bool = False,
) -> bool:
    """Attempt one cleanup job without surfacing post-commit failures to callers.

    Args:
        client: Service-role Supabase client.
        job: Persisted cleanup plan.
        deleted_resource_confirmed: Whether the caller just committed the root
            deletion. Reapers leave staged jobs alone while the root exists.

    Returns:
        ``True`` when all objects were removed and the outbox row was cleared;
        ``False`` when the job was skipped or retained for retry.
    """
    if job.state is StorageCleanupState.STAGED:
        if not deleted_resource_confirmed and _resource_exists(client, job):
            return False
        job = _mark_pending(client, job)

    try:
        _remove_objects(client, job.objects)
        _remove_sandboxes(job.sandbox_ids)
    except Exception as error:  # noqa: BLE001 - every external API failure is retryable
        _record_failure(client, job, error)
        logger.warning(
            "External cleanup job %s failed and remains queued for retry",
            job.id,
            exc_info=True,
        )
        return False

    try:
        _delete_job(client, job.id)
    except Exception:  # noqa: BLE001 - outbox acknowledgement is also retryable
        # Object removal is idempotent. Leaving the job behind makes a later
        # pass repeat the no-op removes and retry only the outbox acknowledgement.
        logger.warning(
            "External cleanup job %s removed its objects but could not clear its outbox row",
            job.id,
            exc_info=True,
        )
        return False
    return True


def cancel_storage_cleanup_job(client: SupabaseClient, job: StorageCleanupJob) -> None:
    """Best-effort cancellation after object and metadata commit together.

    A cancellation failure intentionally leaves the job staged. The reaper
    will not touch it while the root exists; if the root is concurrently
    deleted, the redundant cleanup is safe because Storage removal is
    idempotent.

    Args:
        client: Service-role Supabase client.
        job: Staged compensation created before the object upload.
    """
    try:
        _delete_job(client, job.id)
    except Exception:  # noqa: BLE001 - redundant staged cleanup is safe
        logger.warning("Could not cancel Storage cleanup job %s", job.id, exc_info=True)


def drain_storage_cleanup_jobs(client: SupabaseClient) -> None:
    """Process a stable, fully paged snapshot of pending cleanup jobs."""
    jobs: list[StorageCleanupJob] = []
    offset = 0
    while True:
        result = (
            client.table("storage_cleanup_jobs")
            .select("*")
            .order("created_at")
            .order("id")
            .range(offset, offset + _CLEANUP_PAGE_SIZE - 1)
            .execute()
        )
        page = [StorageCleanupJob.from_row(row) for row in result_rows(result)]
        jobs.extend(page)
        if len(page) < _CLEANUP_PAGE_SIZE:
            break
        offset += _CLEANUP_PAGE_SIZE

    for job in jobs:
        process_storage_cleanup_job(client, job)


def _resource_exists(client: SupabaseClient, job: StorageCleanupJob) -> bool:
    """Return whether a staged cleanup job still has a live root row."""
    match job.resource_type:
        case StorageCleanupResourceType.WORLD_MODEL:
            table = "world_models"
        case StorageCleanupResourceType.AGENT:
            table = "agents"
    result = client.table(table).select("id").eq("id", job.resource_id).limit(1).execute()
    return bool(result_rows(result))


def _mark_pending(client: SupabaseClient, job: StorageCleanupJob) -> StorageCleanupJob:
    """Promote a safe staged job before touching Storage."""
    try:
        row = update_by_id(
            client,
            "storage_cleanup_jobs",
            job.id,
            {"state": StorageCleanupState.PENDING.value, "updated_at": now_iso()},
        )
    except Exception:  # noqa: BLE001 - a staged row remains safe without promotion
        # The durable staged row is still sufficient: after the root disappears,
        # every future reaper pass can prove that it is safe to retry.
        logger.warning("Could not mark Storage cleanup job %s pending", job.id, exc_info=True)
        return job.model_copy(update={"state": StorageCleanupState.PENDING})
    return StorageCleanupJob.from_row(row)


def _remove_objects(client: SupabaseClient, objects: tuple[StorageCleanupObject, ...]) -> None:
    """Remove an exact object set through the Storage API in supported batches."""
    paths_by_bucket: dict[str, list[str]] = {}
    for item in objects:
        paths_by_bucket.setdefault(item.bucket, []).append(item.path)
    for bucket, paths in paths_by_bucket.items():
        bucket_client = client.storage.from_(bucket)
        if not isinstance(bucket_client, RemoveCapableStorageBucket):
            msg = "Supabase storage bucket client does not support remove"
            raise RepositoryError(msg)
        for start in range(0, len(paths), _STORAGE_DELETE_BATCH_SIZE):
            bucket_client.remove(paths[start : start + _STORAGE_DELETE_BATCH_SIZE])


def _remove_sandboxes(sandbox_ids: tuple[str, ...]) -> None:
    """Permanently delete legacy E2B workspaces after their root row is gone.

    Only pre-pivot agent outbox rows carry sandbox ids; nothing stages new
    ones. The kill is idempotent on the provider side.
    """
    if not sandbox_ids:
        return
    from e2b import Sandbox

    key = os.environ.get(E2B_API_KEY_ENV)
    if not key:
        msg = f"set ${E2B_API_KEY_ENV} to drain legacy workspace cleanup jobs"
        raise RuntimeError(msg)
    for sandbox_id in sandbox_ids:
        Sandbox.kill(sandbox_id, api_key=key)


def _record_failure(client: SupabaseClient, job: StorageCleanupJob, error: Exception) -> None:
    """Best-effort persistence of retry diagnostics without masking the 204."""
    try:
        update_by_id(
            client,
            "storage_cleanup_jobs",
            job.id,
            {
                "state": StorageCleanupState.PENDING.value,
                "attempt_count": job.attempt_count + 1,
                "last_error": str(error),
                "updated_at": now_iso(),
            },
        )
    except Exception:  # noqa: BLE001 - diagnostics must not mask the completed delete
        logger.warning("Could not record failure for Storage cleanup job %s", job.id, exc_info=True)


def _delete_job(client: SupabaseClient, job_id: str) -> None:
    """Acknowledge a completed cleanup job."""
    query = client.table("storage_cleanup_jobs")
    if not isinstance(query, DeleteCapableQuery):
        msg = "Supabase query builder does not support delete"
        raise RepositoryError(msg)
    query.delete().eq("id", job_id).execute()
