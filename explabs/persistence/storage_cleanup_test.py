# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for durable Supabase Storage cleanup."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import pytest

from explabs.db.fake_supabase_test import FakeStorageBucket, FakeSupabaseClient
from explabs.db.repositories import SupabaseStorageBucket
from explabs.persistence.storage_cleanup import (
    StorageCleanupJob,
    StorageCleanupResourceType,
    StorageCleanupState,
    drain_storage_cleanup_jobs,
    process_storage_cleanup_job,
    stage_world_model_cleanup,
)


@dataclass(frozen=True)
class _FailingBucket(FakeStorageBucket):
    """Storage bucket that injects a transient remove failure."""

    def remove(self, paths: Sequence[str]) -> object:
        """Fail without removing bytes."""
        _ = paths
        msg = "transient Storage outage"
        raise RuntimeError(msg)


@dataclass(frozen=True)
class _FailingStorage:
    """Storage facade that returns a failing bucket."""

    uploads: dict[tuple[str, str], bytes]

    def from_(self, bucket: str) -> SupabaseStorageBucket:
        """Return the failure-injecting bucket."""
        return _FailingBucket(bucket=bucket, uploads=self.uploads)


def test_successful_cleanup_removes_every_object_and_clears_the_job() -> None:
    """Cleanup batches large object sets and acknowledges its outbox row."""
    client = FakeSupabaseClient()
    paths = tuple(f"traces/wm-1/{index}.jsonl" for index in range(1_001))
    for path in paths:
        client.fake_storage.uploads[("bucket-1", path)] = b"trace"
    job = stage_world_model_cleanup(client, "wm-1", {"bucket-1": paths})

    assert job is not None
    assert process_storage_cleanup_job(client, job, deleted_resource_confirmed=True)
    assert client.fake_storage.uploads == {}
    assert client.tables["storage_cleanup_jobs"] == []


def test_storage_failure_keeps_a_retryable_job_then_reaper_completes_it() -> None:
    """A post-commit outage never turns a successful root delete into a 500."""
    client = FakeSupabaseClient()
    path = "models/wm-1/bundle.tar.gz"
    client.fake_storage.uploads[("bucket-1", path)] = b"bundle"
    job = stage_world_model_cleanup(client, "wm-1", {"bucket-1": (path,)})
    assert job is not None
    client.storage = _FailingStorage(client.fake_storage.uploads)

    assert not process_storage_cleanup_job(client, job, deleted_resource_confirmed=True)
    (queued,) = client.tables["storage_cleanup_jobs"]
    assert queued["state"] == "pending"
    assert queued["attempt_count"] == 1
    assert queued["last_error"] == "transient Storage outage"
    assert ("bucket-1", path) in client.fake_storage.uploads

    client.storage = client.fake_storage
    drain_storage_cleanup_jobs(client)

    assert client.tables["storage_cleanup_jobs"] == []
    assert ("bucket-1", path) not in client.fake_storage.uploads


def test_reaper_skips_staged_cleanup_while_world_model_is_live() -> None:
    """A failed relational delete can never remove bytes through the reaper."""
    client = FakeSupabaseClient()
    client.tables["world_models"] = [{"id": "wm-1"}]
    path = "models/wm-1/bundle.tar.gz"
    client.fake_storage.uploads[("bucket-1", path)] = b"bundle"
    assert stage_world_model_cleanup(client, "wm-1", {"bucket-1": (path,)}) is not None

    drain_storage_cleanup_jobs(client)

    assert len(client.tables["storage_cleanup_jobs"]) == 1
    assert ("bucket-1", path) in client.fake_storage.uploads

    client.tables["world_models"] = []
    drain_storage_cleanup_jobs(client)

    assert client.tables["storage_cleanup_jobs"] == []
    assert ("bucket-1", path) not in client.fake_storage.uploads


def test_legacy_agent_sandbox_cleanup_is_durable_and_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A pre-pivot agent outbox row still drains its E2B workspace, retrying on outage.

    No code stages new agent jobs, but ``AGENT`` rows staged before the endpoint
    pivot must still parse and drain. The kill goes through the inlined e2b
    ``Sandbox.kill``; a transient outage leaves the exact workspace id queued.
    """
    import e2b

    monkeypatch.setenv("E2B_API_KEY", "test-key")
    attempts: list[str] = []

    def fail_once(sandbox_id: str, *, api_key: str) -> None:
        _ = api_key
        attempts.append(sandbox_id)
        if len(attempts) == 1:
            msg = "transient E2B outage"
            raise RuntimeError(msg)

    monkeypatch.setattr(e2b.Sandbox, "kill", staticmethod(fail_once))

    client = FakeSupabaseClient()
    row = (
        client.table("storage_cleanup_jobs")
        .insert(
            {
                "resource_type": StorageCleanupResourceType.AGENT.value,
                "resource_id": "agent-1",
                "state": StorageCleanupState.PENDING.value,
                "objects": [],
                "sandbox_ids": ["sbx-1"],
                "attempt_count": 0,
                "last_error": None,
                "created_at": "2026-07-01T00:00:00Z",
                "updated_at": "2026-07-01T00:00:00Z",
            }
        )
        .execute()
    )
    job = StorageCleanupJob.from_row(row.data[0])

    assert not process_storage_cleanup_job(client, job, deleted_resource_confirmed=True)
    (queued,) = client.tables["storage_cleanup_jobs"]
    assert queued["sandbox_ids"] == ["sbx-1"]
    assert queued["last_error"] == "transient E2B outage"

    drain_storage_cleanup_jobs(client)

    assert attempts == ["sbx-1", "sbx-1"]
    assert client.tables["storage_cleanup_jobs"] == []
