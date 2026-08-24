# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Horizontally safe Storage-to-ClickHouse trace projection worker."""

from __future__ import annotations

import logging
import os
import socket
import threading
from collections.abc import Sequence
from typing import Protocol, cast

from pydantic import BaseModel, ConfigDict, Field

from explabs.db.repositories import SupabaseClient
from explabs.db.stores.trace_ingest_store import TraceIngestStore
from explabs.db.stores.trace_projection_store import TraceDeletionJob, TraceProjectionJob
from explabs.persistence.object_storage import SIGNED_UPLOAD_EXPIRES_IN, storage_bucket
from explabs.trace_acquisition.telemetry_ingest import (
    TelemetryTraceErrorCode,
    TelemetryTraceObjectError,
    verify_stored_trace_object,
)
from explabs.trace_acquisition.trace_normalization import (
    NormalizedTraceRow,
    normalize_trace_object,
)

logger = logging.getLogger(__name__)


class _DownloadBucket(Protocol):
    """Storage surface required by the projection worker."""

    def download(self, path: str) -> bytes:
        """Download exact object bytes."""
        ...

    def remove(self, paths: Sequence[str]) -> object:
        """Permanently remove stored objects by path."""
        ...


class TraceProjectionQueue(Protocol):
    """Leased queue capabilities used by the worker."""

    def claim(
        self,
        worker_id: str,
        *,
        limit: int = 1,
        lease_seconds: int = 120,
    ) -> tuple[TraceProjectionJob, ...]:
        """Claim eligible jobs."""
        ...

    def ack(self, job: TraceProjectionJob, *, projected_rows: int) -> bool:
        """Acknowledge one currently owned job."""
        ...

    def nack(
        self,
        job: TraceProjectionJob,
        *,
        retry_seconds: int,
        error_code: str,
    ) -> bool:
        """Release one failed job."""
        ...

    def claim_deletions(
        self,
        worker_id: str,
        *,
        limit: int = 16,
        lease_seconds: int = 120,
    ) -> tuple[TraceDeletionJob, ...]:
        """Claim tenant-scoped erasure jobs."""
        ...

    def ack_deletion(self, job: TraceDeletionJob) -> bool:
        """Acknowledge one applied erasure."""
        ...

    def nack_deletion(
        self,
        job: TraceDeletionJob,
        *,
        retry_seconds: int,
        error_code: str,
    ) -> bool:
        """Release one failed erasure."""
        ...


class TraceProjectionSink(Protocol):
    """ClickHouse operations required by the projection worker."""

    def insert(self, rows: Sequence[NormalizedTraceRow]) -> None:
        """Insert normalized trace rows."""
        ...

    def count_ingest(
        self,
        *,
        org_id: str,
        ingest_id: str,
        projection_version: int,
    ) -> int:
        """Return projected rows for one versioned tenant ingest."""
        ...

    def delete_ingest(self, *, org_id: str, ingest_id: str) -> None:
        """Erase all projections for one tenant ingest."""
        ...


class TraceProjectionWorkerSettings(BaseModel):
    """Bounded scheduling settings for each projection worker replica."""

    model_config = ConfigDict(frozen=True)

    claim_limit: int = Field(default=1, ge=1, le=16)
    deletion_limit: int = Field(default=16, ge=1, le=100)
    lease_seconds: int = Field(default=300, ge=30, le=900)
    poll_seconds: float = Field(default=1.0, gt=0, le=60)
    retry_seconds: int = Field(default=10, ge=1, le=3600)

    @classmethod
    def from_env(cls) -> TraceProjectionWorkerSettings:
        """Load optional worker scheduling overrides from the environment."""
        return cls(
            claim_limit=int(os.environ.get("CLICKHOUSE_TRACE_CLAIM_LIMIT", "1")),
            deletion_limit=int(os.environ.get("CLICKHOUSE_TRACE_DELETION_LIMIT", "16")),
            lease_seconds=int(os.environ.get("CLICKHOUSE_TRACE_LEASE_SECONDS", "300")),
            poll_seconds=float(os.environ.get("CLICKHOUSE_TRACE_POLL_SECONDS", "1")),
            retry_seconds=int(os.environ.get("CLICKHOUSE_TRACE_RETRY_SECONDS", "10")),
        )


def _require_ack(acknowledged: bool) -> None:
    """Raise when claim fencing prevents terminal acknowledgement."""
    if not acknowledged:
        msg = "Trace projection lost its claim before acknowledgement"
        raise RuntimeError(msg)


class TraceProjectionWorker:
    """Replay immutable trace objects into the normalized analytical store."""

    def __init__(
        self,
        queue: TraceProjectionQueue,
        clickhouse: TraceProjectionSink,
        storage_client: SupabaseClient,
        *,
        worker_id: str | None = None,
        settings: TraceProjectionWorkerSettings | None = None,
    ) -> None:
        """Initialize one worker replica with independent clients."""
        self._queue = queue
        self._clickhouse = clickhouse
        self._storage_client = storage_client
        self._ingests = TraceIngestStore(storage_client)
        self._worker_id = worker_id or f"{socket.gethostname()}:{os.getpid()}:trace"
        self._settings = settings or TraceProjectionWorkerSettings.from_env()

    def run_once(self) -> int:
        """Project one bounded claim set, independently retrying each object."""
        settings = self._settings
        completed = self._run_deletions()
        completed += self._run_abandoned()
        jobs = self._queue.claim(
            self._worker_id,
            limit=settings.claim_limit,
            lease_seconds=settings.lease_seconds,
        )
        for job in jobs:
            try:
                projected_rows = self._project(job)
                _require_ack(self._queue.ack(job, projected_rows=projected_rows))
            except TelemetryTraceObjectError as error:
                self._fail_terminal(job, error)
                completed += 1
                continue
            except Exception as error:  # noqa: BLE001 - durable retry boundary
                error_code = type(error).__name__[:128]
                try:
                    self._queue.nack(
                        job,
                        retry_seconds=settings.retry_seconds,
                        error_code=error_code,
                    )
                except Exception:
                    logger.exception(
                        "Trace projection nack failed", extra={"ingest_id": job.ingest_id}
                    )
                logger.warning(
                    "Trace ClickHouse projection failed",
                    exc_info=True,
                    extra={"ingest_id": job.ingest_id},
                )
                continue
            completed += 1
        return completed

    def _run_deletions(self) -> int:
        """Apply durable tenant erasures before admitting new trace rows."""
        settings = self._settings
        jobs = self._queue.claim_deletions(
            self._worker_id,
            limit=settings.deletion_limit,
            lease_seconds=settings.lease_seconds,
        )
        completed = 0
        for job in jobs:
            try:
                self._clickhouse.delete_ingest(org_id=job.org_id, ingest_id=job.ingest_id)
                _require_ack(self._queue.ack_deletion(job))
            except Exception as error:  # noqa: BLE001 - durable retry boundary
                error_code = type(error).__name__[:128]
                try:
                    self._queue.nack_deletion(
                        job,
                        retry_seconds=settings.retry_seconds,
                        error_code=error_code,
                    )
                except Exception:
                    logger.exception(
                        "Trace ClickHouse deletion nack failed",
                        extra={"ingest_id": job.ingest_id},
                    )
                logger.warning(
                    "Trace ClickHouse deletion failed",
                    exc_info=True,
                    extra={"ingest_id": job.ingest_id},
                )
                continue
            completed += 1
        return completed

    def run(self, stop: threading.Event) -> None:
        """Drain projection work until the shared process stop event is set."""
        while not stop.is_set():
            if self.run_once() == 0 and stop.wait(self._settings.poll_seconds):
                return

    def _project(self, job: TraceProjectionJob) -> int:
        """Download, verify actual bytes, normalize, insert, and read-verify."""
        if not job.result_path:
            raise TelemetryTraceObjectError(
                TelemetryTraceErrorCode.OBJECT_MISSING,
                "Projection job is missing its reserved object path",
            )
        content = self._download(job.result_path)
        verified = verify_stored_trace_object(
            content,
            expected_sha256=job.object_sha256,
            expected_byte_size=job.byte_size,
        )
        if job.object_sha256 is None:
            self._ingests.record_verified_object(
                job.ingest_id,
                claim_token=job.claim_token,
                object_sha256=verified.sha256,
                byte_size=verified.byte_size,
                trace_count=verified.trace_count,
            )
        source_kind = _source_text(job.source, "source_kind") or "unknown"
        source_label = _source_text(job.source, "source_label") or "unknown"
        transport_kind = _source_text(job.source, "provider") or (
            "upload" if _source_text(job.source, "kind") == "file" else "unknown"
        )
        rows = normalize_trace_object(
            content or b"",
            org_id=job.org_id,
            ingest_id=job.ingest_id,
            source_kind=source_kind,
            transport_kind=transport_kind,
            source_label=source_label,
            object_sha256=verified.sha256,
            received_at=job.received_at,
            projection_version=job.projection_version,
            projection_attempt=job.projection_attempt,
        )
        self._clickhouse.insert(rows)
        stored_count = self._clickhouse.count_ingest(
            org_id=job.org_id,
            ingest_id=job.ingest_id,
            projection_version=job.projection_version,
        )
        if stored_count != len(rows):
            msg = "ClickHouse trace projection count does not match normalized rows"
            raise RuntimeError(msg)
        return stored_count

    def _run_abandoned(self) -> int:
        """Delete objects for abandoned and failed uploads, then drop locators.

        A non-missing Storage error leaves the locator in place so another
        replica can retry; the worker loop itself stays alive.
        """
        records = self._ingests.claim_abandoned_uploads(
            older_than_seconds=SIGNED_UPLOAD_EXPIRES_IN,
            limit=self._settings.deletion_limit,
        )
        completed = 0
        for record in records:
            path = record.upload_path or record.result_path
            if path and not self._remove(path):
                continue
            delete_row = record.error_code == TelemetryTraceErrorCode.ABANDONED_UPLOAD.value
            self._ingests.ack_abandoned_upload(record.id, delete_row=delete_row)
            completed += 1
        return completed

    def _fail_terminal(self, job: TraceProjectionJob, error: TelemetryTraceObjectError) -> None:
        """Record a typed terminal error and delete the reserved object."""
        try:
            failed = self._ingests.fail_telemetry_ingest(
                job.ingest_id,
                claim_token=job.claim_token,
                error_code=error.code.value,
                message=error.message,
            )
        except Exception:
            logger.exception(
                "Trace ingest terminal fail RPC failed",
                extra={"ingest_id": job.ingest_id},
            )
            return
        if failed and job.result_path and self._remove(job.result_path):
            self._ingests.ack_abandoned_upload(job.ingest_id, delete_row=False)
        logger.warning(
            "Trace object verification failed",
            extra={"ingest_id": job.ingest_id, "error_code": error.code.value},
        )

    def _download(self, path: str) -> bytes | None:
        """Return stored bytes, or None when Storage has no object at ``path``."""
        bucket = cast("_DownloadBucket", self._storage_client.storage.from_(storage_bucket()))
        try:
            return bucket.download(path)
        except Exception as error:
            if _is_missing_object(error):
                return None
            raise

    def _remove(self, path: str) -> bool:
        """Delete one object. Missing is success; other errors stay retryable.

        Returns:
            True when the object is gone (deleted or already missing). False
            when Storage failed for any other reason — callers must keep the
            locator so another worker pass can retry.
        """
        bucket = cast("_DownloadBucket", self._storage_client.storage.from_(storage_bucket()))
        try:
            bucket.remove([path])
        except Exception as error:  # noqa: BLE001 - missing objects are already gone
            if _is_missing_object(error):
                return True
            logger.warning("Trace object cleanup failed", extra={"path": path}, exc_info=True)
            return False
        return True


def start_trace_projection_thread(
    worker: TraceProjectionWorker,
    stop: threading.Event,
) -> threading.Thread:
    """Start the projection loop on a named daemon thread."""
    thread = threading.Thread(
        target=worker.run,
        args=(stop,),
        name="trace-clickhouse-projection",
        daemon=True,
    )
    thread.start()
    return thread


def _source_text(source: dict[str, object], key: str) -> str | None:
    """Read one string from a persisted secret-free source descriptor."""
    value = source.get(key)
    return value if isinstance(value, str) and value else None


def _is_missing_object(error: Exception) -> bool:
    """Return whether Storage reported that the object does not exist."""
    if isinstance(error, KeyError | FileNotFoundError):
        return True
    status = getattr(error, "status_code", None)
    if status is None:
        response = getattr(error, "response", None)
        status = getattr(response, "status_code", None)
    if status == 404:
        return True
    text = str(error).lower()
    return "not found" in text or "object not found" in text
