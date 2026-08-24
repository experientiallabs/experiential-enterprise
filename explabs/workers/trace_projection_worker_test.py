# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the durable Storage-to-ClickHouse projection loop."""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import cast

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.repositories import SupabaseStorage
from explabs.db.stores.trace_ingest_store import TraceIngestStatus, TraceIngestStore
from explabs.db.stores.trace_projection_store import TraceDeletionJob, TraceProjectionJob
from explabs.persistence.object_storage import storage_bucket
from explabs.trace_acquisition.telemetry_ingest import TelemetryTraceErrorCode
from explabs.trace_acquisition.trace_normalization import NormalizedTraceRow
from explabs.workers.trace_projection_worker import (
    TraceProjectionWorker,
    TraceProjectionWorkerSettings,
)

_CONTENT = b'{"trace_id":"t-1","span_id":"s-1"}\n'


def _job(*, byte_size: int | None = None) -> TraceProjectionJob:
    """Build one claimed projection job."""
    return TraceProjectionJob(
        ingest_id="72000000-0000-0000-0000-000000000001",
        org_id="71000000-0000-0000-0000-000000000001",
        result_path="orgs/710/traces/object",
        object_sha256=hashlib.sha256(_CONTENT, usedforsecurity=False).hexdigest(),
        byte_size=len(_CONTENT) if byte_size is None else byte_size,
        source={"kind": "file", "source_kind": "otlp", "source_label": "prod"},
        received_at="2026-08-22T20:00:00Z",
        projection_version=1,
        projection_attempt=1,
        claim_token="73000000-0000-0000-0000-000000000001",  # noqa: S106
    )


@dataclass
class _Queue:
    """Scripted queue with ack/nack evidence."""

    jobs: tuple[TraceProjectionJob, ...]
    deletions: tuple[TraceDeletionJob, ...] = ()
    acknowledged: list[tuple[str, int]] = field(default_factory=list)
    rejected: list[tuple[str, str]] = field(default_factory=list)
    acknowledged_deletions: list[str] = field(default_factory=list)

    def claim(
        self,
        worker_id: str,
        *,
        limit: int = 1,
        lease_seconds: int = 120,
    ) -> tuple[TraceProjectionJob, ...]:
        """Return scripted jobs once."""
        _ = worker_id, limit, lease_seconds
        jobs, self.jobs = self.jobs, ()
        return jobs

    def ack(self, job: TraceProjectionJob, *, projected_rows: int) -> bool:
        """Record one acknowledgement."""
        self.acknowledged.append((job.ingest_id, projected_rows))
        return True

    def nack(
        self,
        job: TraceProjectionJob,
        *,
        retry_seconds: int,
        error_code: str,
    ) -> bool:
        """Record one retry release."""
        _ = retry_seconds
        self.rejected.append((job.ingest_id, error_code))
        return True

    def claim_deletions(
        self,
        worker_id: str,
        *,
        limit: int = 16,
        lease_seconds: int = 120,
    ) -> tuple[TraceDeletionJob, ...]:
        """Return scripted erasures once."""
        _ = worker_id, limit, lease_seconds
        jobs, self.deletions = self.deletions, ()
        return jobs

    def ack_deletion(self, job: TraceDeletionJob) -> bool:
        """Record one applied erasure."""
        self.acknowledged_deletions.append(job.ingest_id)
        return True

    def nack_deletion(
        self,
        job: TraceDeletionJob,
        *,
        retry_seconds: int,
        error_code: str,
    ) -> bool:
        """Record one failed erasure."""
        _ = retry_seconds
        self.rejected.append((job.ingest_id, error_code))
        return True


@dataclass
class _ClickHouse:
    """In-memory analytical sink with read-back count."""

    inserted: list[NormalizedTraceRow] = field(default_factory=list)
    count: int = 1
    deleted: list[tuple[str, str]] = field(default_factory=list)

    def insert(self, rows: Sequence[NormalizedTraceRow]) -> None:
        """Capture normalized rows."""
        self.inserted.extend(rows)

    def count_ingest(self, **_kwargs: object) -> int:
        """Return the scripted verification count."""
        return self.count

    def delete_ingest(self, *, org_id: str, ingest_id: str) -> None:
        """Capture one synchronous tenant erasure."""
        self.deleted.append((org_id, ingest_id))


def _worker(queue: _Queue, clickhouse: _ClickHouse) -> TraceProjectionWorker:
    """Build a deterministic once-worker with fake Storage."""
    client = FakeSupabaseClient()
    path = _job().result_path
    assert path is not None
    client.fake_storage.uploads[(storage_bucket(), path)] = _CONTENT
    return TraceProjectionWorker(
        queue,
        clickhouse,
        client,
        worker_id="worker-a",
        settings=TraceProjectionWorkerSettings(poll_seconds=0.01),
    )


def test_worker_acknowledges_only_after_insert_and_read_back() -> None:
    """A successful immutable-object replay reaches terminal projection state."""
    queue = _Queue((_job(),))
    clickhouse = _ClickHouse()

    assert _worker(queue, clickhouse).run_once() == 1
    assert len(clickhouse.inserted) == 1
    assert queue.acknowledged == [(_job().ingest_id, 1)]
    assert queue.rejected == []


def test_worker_retries_size_mismatch_without_inserting() -> None:
    """Corrupted or truncated Storage bytes never reach ClickHouse or ack."""
    queue = _Queue((_job(byte_size=len(_CONTENT) + 1),))
    clickhouse = _ClickHouse()

    assert _worker(queue, clickhouse).run_once() == 0
    assert clickhouse.inserted == []
    assert queue.acknowledged == []
    assert queue.rejected == [(_job().ingest_id, "ValueError")]


def test_worker_retries_when_clickhouse_read_back_is_incomplete() -> None:
    """An acknowledged insert with missing rows remains replayable."""
    queue = _Queue((_job(),))
    clickhouse = _ClickHouse(count=0)

    assert _worker(queue, clickhouse).run_once() == 0
    assert len(clickhouse.inserted) == 1
    assert queue.acknowledged == []
    assert queue.rejected == [(_job().ingest_id, "RuntimeError")]


def test_worker_fails_missing_object_without_retrying() -> None:
    """A reserved path with no Storage object is a typed terminal failure."""
    job = _job()
    queue = _Queue((job,))
    clickhouse = _ClickHouse()
    client = FakeSupabaseClient()
    worker = TraceProjectionWorker(
        queue,
        clickhouse,
        client,
        worker_id="worker-a",
        settings=TraceProjectionWorkerSettings(poll_seconds=0.01),
    )

    assert worker.run_once() == 1
    assert clickhouse.inserted == []
    assert queue.acknowledged == []
    assert queue.rejected == []


class _FailingRemoveStorage:
    """Storage facade whose remove raises a retryable (non-missing) error."""

    def __init__(self, uploads: dict[tuple[str, str], bytes], error: Exception) -> None:
        self.uploads = uploads
        self.error = error

    def from_(self, bucket: str) -> _FailingRemoveBucket:
        """Return a bucket that can download but cannot delete."""
        return _FailingRemoveBucket(bucket, self.uploads, self.error)


class _FailingRemoveBucket:
    """In-memory bucket that fails every delete."""

    def __init__(
        self, bucket: str, uploads: dict[tuple[str, str], bytes], error: Exception
    ) -> None:
        self.bucket = bucket
        self.uploads = uploads
        self.error = error

    def download(self, path: str) -> bytes:
        """Return stored bytes."""
        return self.uploads[(self.bucket, path)]

    def remove(self, paths: Sequence[str]) -> object:
        """Raise the configured Storage failure without dropping locators."""
        _ = paths
        raise self.error


def _attach_failing_remove(client: FakeSupabaseClient, error: Exception) -> None:
    """Install a download-capable Storage stand-in that fails deletes."""
    client.storage = cast(
        "SupabaseStorage",
        _FailingRemoveStorage(client.fake_storage.uploads, error),
    )


def _seed_claimed_ingest(client: FakeSupabaseClient, job: TraceProjectionJob) -> None:
    """Put a running router-free ingest and its live claim into the fake tables."""
    client.tables["trace_ingests"] = [
        {
            "id": job.ingest_id,
            "org_id": job.org_id,
            "world_model_id": None,
            "source": job.source,
            "status": "running",
            "upload_path": job.result_path,
            "result_path": job.result_path,
        }
    ]
    client.tables["trace_clickhouse_projections"] = [
        {
            "ingest_id": job.ingest_id,
            "org_id": job.org_id,
            "state": "running",
            "claim_token": job.claim_token,
            "projection_version": job.projection_version,
        }
    ]


def test_worker_applies_deletions_before_new_projection_work() -> None:
    """An ingest deletion is durably erased and fenced before queue removal."""
    deletion = TraceDeletionJob(
        ingest_id=_job().ingest_id,
        org_id=_job().org_id,
        claim_token="74000000-0000-0000-0000-000000000001",  # noqa: S106
    )
    queue = _Queue((), deletions=(deletion,))
    clickhouse = _ClickHouse()

    assert _worker(queue, clickhouse).run_once() == 1
    assert clickhouse.deleted == [(deletion.org_id, deletion.ingest_id)]
    assert queue.acknowledged_deletions == [deletion.ingest_id]


def test_terminal_missing_object_keeps_locator_when_delete_is_not_missing() -> None:
    """OBJECT_MISSING still records the error; a failed cleanup stays retryable."""
    job = _job()
    queue = _Queue((job,))
    clickhouse = _ClickHouse()
    client = FakeSupabaseClient()
    _seed_claimed_ingest(client, job)
    _attach_failing_remove(client, RuntimeError("storage unavailable"))
    worker = TraceProjectionWorker(
        queue,
        clickhouse,
        client,
        worker_id="worker-a",
        settings=TraceProjectionWorkerSettings(poll_seconds=0.01),
    )

    assert worker.run_once() == 1
    record = TraceIngestStore(client).get_ingest(job.ingest_id)
    assert record is not None
    assert record.status is TraceIngestStatus.ERROR
    assert record.error_code == TelemetryTraceErrorCode.OBJECT_MISSING.value
    assert record.upload_path == job.result_path
    assert record.result_path == job.result_path
    assert client.tables.get("trace_clickhouse_projections") == []


def test_abandoned_cleanup_keeps_row_when_storage_delete_fails() -> None:
    """Abandoned claim does not drop the receipt or locator after a delete error."""
    client = FakeSupabaseClient()
    path = "orgs/710/traces/abandoned"
    client.tables["trace_ingests"] = [
        {
            "id": _job().ingest_id,
            "org_id": _job().org_id,
            "world_model_id": None,
            "source": {"kind": "file"},
            "status": "pending",
            "upload_path": path,
            "error_code": None,
            "created_at": "2026-08-22T00:00:00+00:00",
        }
    ]
    client.fake_storage.uploads[(storage_bucket(), path)] = _CONTENT
    _attach_failing_remove(client, RuntimeError("storage unavailable"))
    worker = TraceProjectionWorker(
        _Queue(()),
        _ClickHouse(),
        client,
        worker_id="worker-a",
        settings=TraceProjectionWorkerSettings(poll_seconds=0.01),
    )

    assert worker.run_once() == 0
    record = TraceIngestStore(client).get_ingest(_job().ingest_id)
    assert record is not None
    assert record.error_code == TelemetryTraceErrorCode.ABANDONED_UPLOAD.value
    assert record.upload_path == path
    assert (storage_bucket(), path) in client.fake_storage.uploads


def test_abandoned_cleanup_retries_after_a_failed_delete() -> None:
    """A later pass deletes the object and receipt once Storage succeeds."""
    client = FakeSupabaseClient()
    path = "orgs/710/traces/abandoned"
    ingest_id = _job().ingest_id
    client.tables["trace_ingests"] = [
        {
            "id": ingest_id,
            "org_id": _job().org_id,
            "world_model_id": None,
            "source": {"kind": "file"},
            "status": "error",
            "upload_path": path,
            "error_code": TelemetryTraceErrorCode.ABANDONED_UPLOAD.value,
            "created_at": "2026-08-22T00:00:00+00:00",
        }
    ]
    client.fake_storage.uploads[(storage_bucket(), path)] = _CONTENT
    failing = TraceProjectionWorker(
        _Queue(()),
        _ClickHouse(),
        client,
        worker_id="worker-a",
        settings=TraceProjectionWorkerSettings(poll_seconds=0.01),
    )
    _attach_failing_remove(client, RuntimeError("storage unavailable"))
    assert failing.run_once() == 0
    assert TraceIngestStore(client).get_ingest(ingest_id) is not None

    client.storage = client.fake_storage
    recovered = TraceProjectionWorker(
        _Queue(()),
        _ClickHouse(),
        client,
        worker_id="worker-b",
        settings=TraceProjectionWorkerSettings(poll_seconds=0.01),
    )
    assert recovered.run_once() == 1
    assert TraceIngestStore(client).get_ingest(ingest_id) is None
    assert (storage_bucket(), path) not in client.fake_storage.uploads


def test_terminal_cleanup_treats_already_missing_object_as_success() -> None:
    """A 404/missing delete is the desired end state and may clear locators."""
    job = _job()
    queue = _Queue((job,))
    clickhouse = _ClickHouse()
    client = FakeSupabaseClient()
    _seed_claimed_ingest(client, job)
    _attach_failing_remove(client, FileNotFoundError(job.result_path))
    worker = TraceProjectionWorker(
        queue,
        clickhouse,
        client,
        worker_id="worker-a",
        settings=TraceProjectionWorkerSettings(poll_seconds=0.01),
    )

    assert worker.run_once() == 1
    record = TraceIngestStore(client).get_ingest(job.ingest_id)
    assert record is not None
    assert record.status is TraceIngestStatus.ERROR
    assert record.upload_path is None
    assert record.result_path is None
