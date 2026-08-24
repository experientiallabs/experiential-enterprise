# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for router-free org telemetry trace ingestion."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.trace_ingest_store import TraceIngestStatus, TraceIngestStore
from explabs.db.stores.trace_projection_store import TraceProjectionStore
from explabs.persistence.object_storage import SIGNED_UPLOAD_EXPIRES_IN, storage_bucket
from explabs.trace_acquisition.connectors import (
    REMOTE_TRACE_TRANSPORTS,
    AcquisitionErrorCode,
    ConnectorBatch,
    ConnectorError,
    ConnectorRegistry,
    ConnectorRequest,
    TraceTransportKind,
)
from explabs.trace_acquisition.formats import (
    MAX_TRACE_OBJECT_BYTES,
    TraceUploadFormat,
    TraceUploadValidationError,
)
from explabs.trace_acquisition.telemetry_ingest import (
    TelemetryTraceErrorCode,
    TelemetryTraceIngestService,
    TelemetryTraceNotFoundError,
    TelemetryTraceObjectError,
    verify_stored_trace_object,
)
from explabs.trace_acquisition.trace_normalization import NormalizedTraceRow
from explabs.workers.trace_projection_worker import (
    TraceProjectionWorker,
    TraceProjectionWorkerSettings,
)

ORG_ID = "org-1"
_CONTENT = b'{"trace_id":"a"}\n{"trace_id":"b"}\n'

# Tables an optimizer build would have to touch; ingestion must leave them empty.
_BUILD_TABLES = ("optimizer_projects", "optimizer_project_jobs", "world_models")


class _StubConnector:
    """Scripted connector returning fixed pages and recording credentials."""

    def __init__(
        self,
        kind: TraceTransportKind,
        pages: Mapping[str | None, ConnectorBatch],
    ) -> None:
        """Initialize one transport's scripted pages."""
        self.kind = kind
        self.pages = dict(pages)
        self.credentials: list[str] = []
        self.requests: list[ConnectorRequest] = []

    def fetch_page(
        self,
        request: ConnectorRequest,
        *,
        credential: str,
        cursor: str | None,
        limit: int,
    ) -> ConnectorBatch:
        """Return the scripted page for one cursor."""
        _ = limit
        self.requests.append(request)
        self.credentials.append(credential)
        return self.pages[cursor]


class _ClickHouse:
    """In-memory analytical sink for worker-driven verification tests."""

    def __init__(self) -> None:
        self.inserted: list[NormalizedTraceRow] = []
        self.deleted: list[tuple[str, str]] = []

    def insert(self, rows: Sequence[NormalizedTraceRow]) -> None:
        """Capture normalized rows."""
        self.inserted.extend(rows)

    def count_ingest(self, **_kwargs: object) -> int:
        """Return the inserted row count."""
        return len(self.inserted)

    def delete_ingest(self, *, org_id: str, ingest_id: str) -> None:
        """Capture one erasure."""
        self.deleted.append((org_id, ingest_id))


def _registry(override: _StubConnector | None = None) -> ConnectorRegistry:
    """Build a complete offline registry with one optional override."""
    connectors: dict[TraceTransportKind, _StubConnector] = {
        kind: _StubConnector(kind, {None: ConnectorBatch(records=({"id": kind.value},))})
        for kind in REMOTE_TRACE_TRANSPORTS
    }
    if override is not None:
        connectors[override.kind] = override
    return ConnectorRegistry(connectors)


def _assert_no_build(client: FakeSupabaseClient) -> None:
    """Assert ingestion never created a Project/optimize/world-model build row."""
    for table in _BUILD_TABLES:
        assert not client.tables.get(table), f"{table} must stay empty after telemetry ingest"


def _put(client: FakeSupabaseClient, path: str, content: bytes) -> None:
    """Simulate the client's raw signed PUT into fake Storage."""
    client.fake_storage.uploads[(storage_bucket(), path)] = content


def _project(client: FakeSupabaseClient) -> _ClickHouse:
    """Run one worker pass against the fake queue and Storage."""
    clickhouse = _ClickHouse()
    TraceProjectionWorker(
        TraceProjectionStore(client),
        clickhouse,
        client,
        worker_id="worker-test",
        settings=TraceProjectionWorkerSettings(poll_seconds=0.01),
    ).run_once()
    return clickhouse


def test_prepare_signed_upload_reserves_unpredictable_org_path() -> None:
    """The mint authenticates into an ingest-scoped path and returns no secrets."""
    client = FakeSupabaseClient()
    ticket = TelemetryTraceIngestService(client).prepare_signed_upload(
        org_id=ORG_ID,
        source_kind=TraceUploadFormat.OTLP,
        source_label="prod-otel-august",
        created_by="user-1",
    )

    assert ticket.upload_path.startswith(f"orgs/{ORG_ID}/telemetry-traces/otlp/{ticket.ingest_id}/")
    assert ticket.source_label not in ticket.upload_path
    assert ticket.token
    assert ticket.signed_url.endswith(f"token={ticket.token}")
    assert "service_role" not in ticket.signed_url
    assert ticket.expires_in == SIGNED_UPLOAD_EXPIRES_IN
    record = TraceIngestStore(client).get_ingest(ticket.ingest_id)
    assert record is not None
    assert record.world_model_id is None
    assert record.status is TraceIngestStatus.PENDING
    assert record.upload_path == ticket.upload_path
    _assert_no_build(client)


def test_prepare_rejects_a_path_like_label() -> None:
    """A label that is a path is refused before a path or ticket is minted."""
    client = FakeSupabaseClient()
    with pytest.raises(TraceUploadValidationError):
        TelemetryTraceIngestService(client).prepare_signed_upload(
            org_id=ORG_ID,
            source_kind=TraceUploadFormat.OTLP,
            source_label="/etc/passwd",
        )
    assert not client.tables.get("trace_ingests")
    assert not client.fake_storage.uploads


def test_signed_upload_does_not_overwrite_an_existing_object() -> None:
    """Official default upsert=false is preserved by the fake mint."""
    client = FakeSupabaseClient()
    ticket = TelemetryTraceIngestService(client).prepare_signed_upload(
        org_id=ORG_ID,
        source_kind=TraceUploadFormat.OTLP,
        source_label="prod",
    )
    _put(client, ticket.upload_path, _CONTENT)
    with pytest.raises(RuntimeError, match="already exists"):
        client.storage.from_(storage_bucket()).create_signed_upload_url(ticket.upload_path)


def test_accept_is_idempotent_and_does_not_trust_missing_bytes() -> None:
    """Finalize enqueues work even before the object exists; a second call is a no-op."""
    client = FakeSupabaseClient()
    service = TelemetryTraceIngestService(client)
    ticket = service.prepare_signed_upload(
        org_id=ORG_ID,
        source_kind=TraceUploadFormat.OTLP,
        source_label="prod",
    )
    first = service.accept_signed_upload(org_id=ORG_ID, ingest_id=ticket.ingest_id)
    second = service.accept_signed_upload(org_id=ORG_ID, ingest_id=ticket.ingest_id)
    assert first.status is TraceIngestStatus.RUNNING
    assert second.id == first.id
    assert len(client.tables["trace_clickhouse_projections"]) == 1
    assert first.object_sha256 is None
    assert first.byte_size is None


def test_accept_denies_a_foreign_org() -> None:
    """Finalize cannot enqueue another tenant's reserved ingest."""
    client = FakeSupabaseClient()
    service = TelemetryTraceIngestService(client)
    ticket = service.prepare_signed_upload(
        org_id=ORG_ID,
        source_kind=TraceUploadFormat.OTLP,
        source_label="prod",
    )
    with pytest.raises(TelemetryTraceNotFoundError):
        service.accept_signed_upload(org_id="org-2", ingest_id=ticket.ingest_id)


def test_worker_verifies_actual_bytes_hash_and_projects_rows() -> None:
    """The worker, not finalize, computes digest/size and projects exact rows."""
    client = FakeSupabaseClient()
    service = TelemetryTraceIngestService(client)
    ticket = service.prepare_signed_upload(
        org_id=ORG_ID,
        source_kind=TraceUploadFormat.OTLP,
        source_label="prod",
    )
    _put(client, ticket.upload_path, _CONTENT)
    service.accept_signed_upload(org_id=ORG_ID, ingest_id=ticket.ingest_id)
    clickhouse = _project(client)

    digest = hashlib.sha256(_CONTENT, usedforsecurity=False).hexdigest()
    record = TraceIngestStore(client).get_ingest(ticket.ingest_id)
    assert record is not None
    assert record.status is TraceIngestStatus.DONE
    assert record.trace_projection_status is not None
    assert record.object_sha256 == digest
    assert record.byte_size == len(_CONTENT)
    assert record.trace_count == 2
    assert len(clickhouse.inserted) == 2
    assert all(row.object_sha256 == digest for row in clickhouse.inserted)
    _assert_no_build(client)


def test_worker_fails_missing_object_without_projecting() -> None:
    """A finalized ingest with no Storage object is a typed terminal error."""
    client = FakeSupabaseClient()
    service = TelemetryTraceIngestService(client)
    ticket = service.prepare_signed_upload(
        org_id=ORG_ID,
        source_kind=TraceUploadFormat.OTLP,
        source_label="prod",
    )
    service.accept_signed_upload(org_id=ORG_ID, ingest_id=ticket.ingest_id)
    _project(client)
    record = TraceIngestStore(client).get_ingest(ticket.ingest_id)
    assert record is not None
    assert record.status is TraceIngestStatus.ERROR
    assert record.error_code == TelemetryTraceErrorCode.OBJECT_MISSING.value


def test_worker_fails_malformed_and_oversized_bytes() -> None:
    """Malformed and oversized objects never reach ClickHouse."""
    client = FakeSupabaseClient()
    service = TelemetryTraceIngestService(client)
    malformed = service.prepare_signed_upload(
        org_id=ORG_ID,
        source_kind=TraceUploadFormat.OTLP,
        source_label="bad",
    )
    _put(client, malformed.upload_path, b"not-json")
    service.accept_signed_upload(org_id=ORG_ID, ingest_id=malformed.ingest_id)
    _project(client)
    bad = TraceIngestStore(client).get_ingest(malformed.ingest_id)
    assert bad is not None
    assert bad.error_code == TelemetryTraceErrorCode.OBJECT_MALFORMED.value
    assert (storage_bucket(), malformed.upload_path) not in client.fake_storage.uploads

    oversized = service.prepare_signed_upload(
        org_id=ORG_ID,
        source_kind=TraceUploadFormat.OTLP,
        source_label="huge",
    )
    _put(client, oversized.upload_path, b"x" * (MAX_TRACE_OBJECT_BYTES + 1))
    service.accept_signed_upload(org_id=ORG_ID, ingest_id=oversized.ingest_id)
    _project(client)
    huge = TraceIngestStore(client).get_ingest(oversized.ingest_id)
    assert huge is not None
    assert huge.error_code == TelemetryTraceErrorCode.OBJECT_TOO_LARGE.value


def test_abandoned_upload_cleanup_deletes_object_and_row() -> None:
    """A stale reservation is reaped after the official signed-URL lifetime."""
    client = FakeSupabaseClient()
    ticket = TelemetryTraceIngestService(client).prepare_signed_upload(
        org_id=ORG_ID,
        source_kind=TraceUploadFormat.OTLP,
        source_label="stale",
    )
    _put(client, ticket.upload_path, _CONTENT)
    created = (datetime.now(UTC) - timedelta(seconds=SIGNED_UPLOAD_EXPIRES_IN + 1)).isoformat()
    client.tables["trace_ingests"][0]["created_at"] = created
    _project(client)
    assert TraceIngestStore(client).get_ingest(ticket.ingest_id) is None
    assert (storage_bucket(), ticket.upload_path) not in client.fake_storage.uploads


def test_verify_stored_trace_object_never_trusts_client_identity() -> None:
    """Caller-supplied hash/size are compared to downloaded bytes, not believed."""
    digest = hashlib.sha256(_CONTENT, usedforsecurity=False).hexdigest()
    verified = verify_stored_trace_object(
        _CONTENT,
        expected_sha256=digest,
        expected_byte_size=len(_CONTENT),
    )
    assert verified.sha256 == digest
    assert verified.trace_count == 2
    with pytest.raises(ValueError, match="digest"):
        verify_stored_trace_object(_CONTENT, expected_sha256="a" * 64)
    with pytest.raises(TelemetryTraceObjectError) as missing:
        verify_stored_trace_object(None)
    assert missing.value.code is TelemetryTraceErrorCode.OBJECT_MISSING


def test_remote_pull_uses_connector_and_lands_as_telemetry() -> None:
    """A Braintrust pull passes the credential transiently and lands, no build."""
    client = FakeSupabaseClient()
    connector = _StubConnector(
        TraceTransportKind.BRAINTRUST,
        {
            None: ConnectorBatch(records=({"id": "1"}, {"id": "2"}), next_cursor="page-2"),
            "page-2": ConnectorBatch(records=({"id": "3"},), next_cursor=None),
        },
    )
    service = TelemetryTraceIngestService(client, connectors=_registry(connector))

    result = service.ingest_remote(
        org_id=ORG_ID,
        transport_kind=TraceTransportKind.BRAINTRUST,
        source_kind=TraceUploadFormat.BRAINTRUST,
        source_label="braintrust-prod",
        credential="bt-secret",
        config={"project": "support"},
        created_by="user-1",
    )

    assert result.trace_count == 3
    assert connector.credentials == ["bt-secret", "bt-secret"]
    record = TraceIngestStore(client).get_ingest(result.ingest_id)
    assert record is not None
    assert record.world_model_id is None
    assert record.status is TraceIngestStatus.DONE
    assert record.source["provider"] == "braintrust"
    assert "bt-secret" not in str(record.source)
    _assert_no_build(client)


def test_remote_pull_deduplicates_repeated_records() -> None:
    """Records repeated across pages are stored once."""
    client = FakeSupabaseClient()
    connector = _StubConnector(
        TraceTransportKind.LANGSMITH,
        {
            None: ConnectorBatch(records=({"id": "1"}, {"id": "2"}), next_cursor="c2"),
            "c2": ConnectorBatch(records=({"id": "2"}, {"id": "3"}), next_cursor=None),
        },
    )
    service = TelemetryTraceIngestService(client, connectors=_registry(connector))
    result = service.ingest_remote(
        org_id=ORG_ID,
        transport_kind=TraceTransportKind.LANGSMITH,
        source_kind=TraceUploadFormat.LANGSMITH,
        source_label="ls-prod",
        credential="ls-secret",
    )
    assert result.trace_count == 3


def test_remote_pull_with_no_records_raises_and_stores_nothing() -> None:
    """An empty remote result is a validation error, not an empty telemetry row."""
    client = FakeSupabaseClient()
    connector = _StubConnector(
        TraceTransportKind.MASTRA,
        {None: ConnectorBatch(records=())},
    )
    service = TelemetryTraceIngestService(client, connectors=_registry(connector))
    with pytest.raises(TraceUploadValidationError):
        service.ingest_remote(
            org_id=ORG_ID,
            transport_kind=TraceTransportKind.MASTRA,
            source_kind=TraceUploadFormat.MASTRA,
            source_label="mastra-prod",
            credential="secret",
        )
    assert not client.tables.get("trace_ingests")


def test_remote_pull_rejects_upload_transport() -> None:
    """The upload sentinel is not a live transport and is refused."""
    client = FakeSupabaseClient()
    service = TelemetryTraceIngestService(client, connectors=_registry())
    with pytest.raises(ConnectorError) as raised:
        service.ingest_remote(
            org_id=ORG_ID,
            transport_kind=TraceTransportKind.UPLOAD,
            source_kind=TraceUploadFormat.OTLP,
            source_label="nope",
            credential="secret",
        )
    assert raised.value.code is AcquisitionErrorCode.INVALID_SOURCE_CONFIG


def test_list_org_telemetry_returns_only_router_free_ingests() -> None:
    """The verify-count read excludes world-model-chained ingest rows."""
    client = FakeSupabaseClient()
    store = TraceIngestStore(client)
    TelemetryTraceIngestService(client).prepare_signed_upload(
        org_id=ORG_ID,
        source_kind=TraceUploadFormat.OTLP,
        source_label="telemetry",
    )
    store.create_ingest(org_id=ORG_ID, source={"kind": "file"}, world_model_id="wm-9")

    rows = store.list_org_telemetry(ORG_ID)
    assert len(rows) == 1
    assert all(row.world_model_id is None for row in rows)
