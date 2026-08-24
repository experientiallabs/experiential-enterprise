# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Org-scoped data wipe backing the Settings privacy delete.

The retained pre-Projects world-model rows (simulations and their traces,
builds, sessions, and artifacts) are readable history, and history a
customer owns must be deletable. This module holds exactly that one
destructive operation — snapshot external objects, stage the durable
cleanup outbox, delete the root row, then drain the staged job — and it
retires together with those tables when that data class is finally dropped.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.routes import get_supabase
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import (
    DeleteCapableQuery,
    JsonObject,
    RepositoryError,
    SupabaseClient,
    result_rows,
)
from explabs.db.stores.artifact_store import ArtifactStore
from explabs.db.stores.catalog_store import CatalogEntryStore
from explabs.db.stores.trace_store import TraceStore
from explabs.persistence.object_storage import storage_bucket
from explabs.persistence.storage_cleanup import (
    cancel_storage_cleanup_job,
    process_storage_cleanup_job,
    stage_world_model_cleanup,
)

router = APIRouter(prefix="/api", tags=["org data"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]

_PAGE_SIZE = 1_000


class OrgDataDeletion(BaseModel):
    """Result of one organization-scoped legacy world-model wipe."""

    model_config = ConfigDict(extra="forbid")

    deleted_world_models: int


@router.delete("/orgs/{org_id}/data", response_model=OrgDataDeletion)
def delete_org_data(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> OrgDataDeletion:
    """Delete every legacy world model the organization owns.

    Each model's stored objects and any pre-pivot E2B workspace ids are
    staged in the durable cleanup outbox before its row is deleted, so the
    relational cascade (traces, builds, sessions, rollouts, artifacts) can
    never orphan live bytes: a failed row delete cancels the staged job, and
    a crash after the row delete leaves a job the startup reaper drains.
    """
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.ADMIN,
        not_found=f"Organization not found: {org_id}",
    )
    deleted = 0
    for world_model_id, catalog_entry_id in _org_world_models(client, org_id):
        if _delete_world_model(client, world_model_id, catalog_entry_id):
            deleted += 1
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.ORG_DATA_DELETE,
        object_type="organization",
        object_id=org_id,
        after={"deleted_world_models": deleted},
    )
    return OrgDataDeletion(deleted_world_models=deleted)


def _delete_world_model(
    client: SupabaseClient, world_model_id: str, catalog_entry_id: str | None
) -> bool:
    """Stage cleanup, delete one root row, then drain the staged job.

    Returns:
        ``True`` when this call deleted the row; ``False`` when a concurrent
        wipe already removed it (the staged job is cancelled, not drained).
    """
    cleanup_job = stage_world_model_cleanup(
        client,
        world_model_id,
        _world_model_storage_paths(client, world_model_id, catalog_entry_id),
        sandbox_ids=_legacy_agent_sandbox_ids(client, world_model_id),
    )
    query = client.table("world_models")
    if not isinstance(query, DeleteCapableQuery):
        msg = "Supabase query builder does not support delete"
        raise RepositoryError(msg)
    result = query.delete().eq("id", world_model_id).execute()
    if not result.data:
        if cleanup_job is not None:
            cancel_storage_cleanup_job(client, cleanup_job)
        return False
    if cleanup_job is not None:
        process_storage_cleanup_job(client, cleanup_job, deleted_resource_confirmed=True)
    return True


def _org_world_models(client: SupabaseClient, org_id: str) -> tuple[tuple[str, str | None], ...]:
    """Snapshot the org's world-model ids before any row is deleted."""
    rows: list[tuple[str, str | None]] = []
    offset = 0
    while True:
        result = (
            client.table("world_models")
            .select("id, catalog_entry_id")
            .eq("org_id", org_id)
            .order("id")
            .range(offset, offset + _PAGE_SIZE - 1)
            .execute()
        )
        page = result_rows(result)
        for row in page:
            entry_id = row.get("catalog_entry_id")
            if entry_id is not None and not isinstance(entry_id, str):
                msg = f"invalid catalog_entry_id for world model {row.get('id')}: {entry_id!r}"
                raise RepositoryError(msg)
            rows.append((str(row["id"]), entry_id))
        if len(page) < _PAGE_SIZE:
            break
        offset += _PAGE_SIZE
    return tuple(rows)


def _world_model_storage_paths(
    client: SupabaseClient, world_model_id: str, catalog_entry_id: str | None
) -> dict[str, tuple[str, ...]]:
    """Snapshot every bundle and trace object path owned by a world model.

    Paths must be read while their metadata rows still exist, but object
    deletion waits until the relational cascade commits. A failed root-row
    delete therefore cannot leave live metadata pointing at missing objects.
    """
    paths_by_bucket: dict[str, set[str]] = defaultdict(set)
    for artifact in ArtifactStore(client).all_for_world_model(world_model_id):
        paths_by_bucket[artifact.storage_bucket].add(artifact.storage_path)

    # Catalog imports clone a trace row that points at the catalog entry's
    # shared object. Deleting one tenant import must remove that metadata row
    # through the DB cascade without deleting bytes used by every other import.
    shared_trace_path: str | None = None
    if catalog_entry_id is not None:
        shared_trace_path = CatalogEntryStore(client).get(catalog_entry_id).traces_storage_path
    for upload in TraceStore(client).all_for_world_model(world_model_id):
        if upload.storage_path == shared_trace_path:
            continue
        paths_by_bucket[storage_bucket()].add(upload.storage_path)
    return {bucket: tuple(sorted(paths)) for bucket, paths in paths_by_bucket.items()}


def _sandbox_id_field(row: JsonObject, column: str, world_model_id: str) -> str | None:
    """Read one nullable sandbox-id column, failing loudly on a non-string."""
    value = row.get(column)
    if value is None:
        return None
    if not isinstance(value, str):
        msg = f"invalid {column} for world model {world_model_id}: {value!r}"
        raise RepositoryError(msg)
    return value


def _legacy_agent_sandbox_ids(client: SupabaseClient, world_model_id: str) -> tuple[str, ...]:
    """Snapshot E2B sandbox ids owned by pre-pivot agent rows of this model.

    The agent product is gone, but its tables (and any still-live persistent
    sandboxes recorded on them) survive until D-004. World-model deletion
    cascades through those legacy rows, so the external ids are captured for
    the durable cleanup outbox before the relational delete commits.
    """
    sandbox_ids: list[str] = []
    agent_ids: list[str] = []
    offset = 0
    while True:
        result = (
            client.table("agents")
            .select("id, workspace_sandbox_id")
            .eq("world_model_id", world_model_id)
            .order("id")
            .range(offset, offset + _PAGE_SIZE - 1)
            .execute()
        )
        page = result_rows(result)
        for row in page:
            agent_ids.append(str(row["id"]))
            workspace_id = _sandbox_id_field(row, "workspace_sandbox_id", world_model_id)
            if workspace_id is not None:
                sandbox_ids.append(workspace_id)
        if len(page) < _PAGE_SIZE:
            break
        offset += _PAGE_SIZE

    chunk_size = 200
    for start in range(0, len(agent_ids), chunk_size):
        offset = 0
        while True:
            result = (
                client.table("agent_sessions")
                .select("id, sandbox_id")
                .in_("agent_id", agent_ids[start : start + chunk_size])
                .order("id")
                .range(offset, offset + _PAGE_SIZE - 1)
                .execute()
            )
            page = result_rows(result)
            for row in page:
                session_sandbox_id = _sandbox_id_field(row, "sandbox_id", world_model_id)
                if session_sandbox_id is not None:
                    sandbox_ids.append(session_sandbox_id)
            if len(page) < _PAGE_SIZE:
                break
            offset += _PAGE_SIZE
    return tuple(dict.fromkeys(sandbox_ids))
