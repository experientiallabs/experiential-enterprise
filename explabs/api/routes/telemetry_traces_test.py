# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""HTTP contract tests for org-scoped telemetry trace ingestion."""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Protocol, cast

import httpx
import pytest
from fastapi.testclient import TestClient

import explabs.api.routes.telemetry_traces as routes_module
import explabs.trace_acquisition.telemetry_ingest as ingest_module
from explabs.api.app import create_app
from explabs.api.conftest import ORG_ID, OTHER_ORG_ID
from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.trace_ingest_store import TraceIngestStore
from explabs.db.stores.trace_projection_store import TraceProjectionStore
from explabs.persistence.object_storage import storage_bucket
from explabs.trace_acquisition.connectors import (
    REMOTE_TRACE_TRANSPORTS,
    ConnectorBatch,
    ConnectorRegistry,
    ConnectorRequest,
    TraceTransportKind,
)
from explabs.workers.trace_projection_worker import (
    TraceProjectionWorker,
    TraceProjectionWorkerSettings,
)

_UPLOAD = f"/api/orgs/{ORG_ID}/telemetry/traces/upload"
_PULL = f"/api/orgs/{ORG_ID}/telemetry/traces/pull"
_LIST = f"/api/orgs/{ORG_ID}/telemetry/traces"
_CONTENT = b'{"trace_id":"a"}\n{"trace_id":"b"}\n'


class _OnePageConnector:
    """One-page offline connector recording the transient credential."""

    def __init__(self, kind: TraceTransportKind) -> None:
        """Initialize one explicit transport kind."""
        self.kind = kind
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
        """Return two records while capturing test evidence only."""
        _ = cursor, limit
        self.requests.append(request)
        self.credentials.append(credential)
        return ConnectorBatch(records=({"id": "r1"}, {"id": "r2"}))


class _ClickHouse:
    """In-memory analytical sink for HTTP+worker tests."""

    def __init__(self) -> None:
        self.inserted: list[object] = []

    def insert(self, rows: Sequence[object]) -> None:
        """Capture normalized rows."""
        self.inserted.extend(rows)

    def count_ingest(self, **_kwargs: object) -> int:
        """Return the inserted row count."""
        return len(self.inserted)

    def delete_ingest(self, **_kwargs: object) -> None:
        """No-op erasure."""


def _stub_registry(
    monkeypatch: pytest.MonkeyPatch,
    *,
    observed: _OnePageConnector | None = None,
) -> None:
    """Replace the production network registry with an offline one."""
    connectors = {
        kind: observed
        if observed is not None and kind is observed.kind
        else _OnePageConnector(kind)
        for kind in REMOTE_TRACE_TRANSPORTS
    }
    registry = ConnectorRegistry(connectors)

    def build_registry(_client: httpx.Client) -> ConnectorRegistry:
        """Return the prebuilt offline registry."""
        return registry

    monkeypatch.setattr(ingest_module, "connector_registry", build_registry)


def _put(supabase: FakeSupabaseClient, path: str, content: bytes) -> None:
    """Simulate the client's raw signed PUT."""
    supabase.fake_storage.uploads[(storage_bucket(), path)] = content


def _create_upload(
    customer_api: TestClient, *, label: str = "prod-otel-august"
) -> dict[str, object]:
    """Create one signed-upload ticket."""
    response = customer_api.post(
        _UPLOAD,
        json={"source_kind": "otlp", "source_label": label},
    )
    assert response.status_code == 201, response.text
    return response.json()


class _HttpResponse(Protocol):
    """TestClient response surface used by these contract tests."""

    status_code: int
    text: str

    def json(self) -> dict[str, object]:
        """Parsed JSON body."""
        ...


def _finalize(customer_api: TestClient, ingest_id: str) -> _HttpResponse:
    """Accept one reserved ingest."""
    return cast("_HttpResponse", customer_api.post(f"{_LIST}/{ingest_id}/finalize"))


def _project(supabase: FakeSupabaseClient) -> None:
    """Drain one worker pass so verify-count can read landed traces."""
    TraceProjectionWorker(
        TraceProjectionStore(supabase),
        _ClickHouse(),
        supabase,
        worker_id="http-worker",
        settings=TraceProjectionWorkerSettings(poll_seconds=0.01),
    ).run_once()


def test_upload_lands_and_verify_count_reads_it_back(
    customer_api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """An xpl_ key reserves, uploads raw bytes, finalizes, and reads the count."""
    ticket = _create_upload(customer_api)
    ingest_id = str(ticket["ingest_id"])
    record = TraceIngestStore(supabase).get_ingest(ingest_id)
    assert record is not None
    _put(supabase, record.upload_path or "", _CONTENT)
    accepted = _finalize(customer_api, ingest_id)
    assert accepted.status_code == 202, accepted.text
    assert accepted.json()["status"] == "accepted"
    assert accepted.json()["sha256"] is None
    running = customer_api.get(_LIST)
    assert running.status_code == 200, running.text
    assert running.json()["traces"][0]["status"] == "running"
    _project(supabase)

    listed = customer_api.get(_LIST)
    assert listed.status_code == 200, listed.text
    summary = listed.json()
    assert summary["total_ingests"] == 1
    assert summary["total_traces"] == 2
    assert summary["traces"][0]["source_label"] == "prod-otel-august"
    assert summary["traces"][0]["status"] == "done"


def test_upload_response_never_exposes_credentials_or_storage_path(
    customer_api: TestClient,
) -> None:
    """The ticket is only a short-lived URL/token; no service material leaks."""
    ticket = _create_upload(customer_api)
    blob = json.dumps(ticket).lower()
    assert "service_role" not in blob
    assert "service_role_key" not in blob
    assert "upload_path" not in ticket
    assert "result_path" not in ticket
    assert ticket["method"] == "PUT"
    assert "token=" in str(ticket["signed_url"])
    assert ticket["token"]


def test_finalize_is_idempotent(customer_api: TestClient, supabase: FakeSupabaseClient) -> None:
    """A second finalize of the same ingest returns the same accepted receipt."""
    ticket = _create_upload(customer_api)
    ingest_id = str(ticket["ingest_id"])
    first = _finalize(customer_api, ingest_id)
    second = _finalize(customer_api, ingest_id)
    assert first.status_code == 202
    assert second.status_code == 202
    assert first.json()["ingest_id"] == second.json()["ingest_id"]
    assert first.json()["sha256"] is None
    assert first.json()["byte_size"] is None
    assert len(supabase.tables.get("trace_clickhouse_projections") or []) == 1


def test_finalize_ignores_client_supplied_hash_and_size(
    customer_api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """Extra finalize body fields cannot become the stored object identity."""
    ticket = _create_upload(customer_api)
    ingest_id = str(ticket["ingest_id"])
    response = customer_api.post(
        f"{_LIST}/{ingest_id}/finalize",
        json={"sha256": "0" * 64, "byte_size": 1},
    )
    assert response.status_code == 202, response.text
    assert response.json()["sha256"] is None
    assert response.json()["byte_size"] is None
    record = TraceIngestStore(supabase).get_ingest(ingest_id)
    assert record is not None
    assert record.object_sha256 is None
    assert record.byte_size is None
    assert len(supabase.tables.get("trace_clickhouse_projections") or []) == 1


def test_unauthenticated_upload_is_denied(supabase: FakeSupabaseClient) -> None:
    """Reservation requires an xpl_ key; no anonymous signed-upload mint."""
    response = TestClient(create_app(client=supabase)).post(
        _UPLOAD,
        json={"source_kind": "otlp", "source_label": "prod"},
    )
    assert response.status_code == 401, response.text


def test_cross_org_upload_is_not_found(customer_api: TestClient) -> None:
    """The org-1 key cannot reserve a path in another org."""
    response = customer_api.post(
        f"/api/orgs/{OTHER_ORG_ID}/telemetry/traces/upload",
        json={"source_kind": "otlp", "source_label": "prod"},
    )
    assert response.status_code == 404, response.text


def test_cross_org_finalize_is_not_found(
    customer_api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """The org-1 key cannot finalize another tenant's reserved ingest."""
    ticket = _create_upload(customer_api)
    ingest_id = str(ticket["ingest_id"])
    other = supabase.tables["trace_ingests"][0]
    other["org_id"] = OTHER_ORG_ID
    response = _finalize(customer_api, ingest_id)
    assert response.status_code == 404, response.text


def test_upload_never_creates_a_build(
    customer_api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """Reservation and accept leave the optimizer Project/job tables empty."""
    ticket = _create_upload(customer_api, label="prod")
    _finalize(customer_api, str(ticket["ingest_id"]))
    assert not supabase.tables.get("optimizer_projects")
    assert not supabase.tables.get("optimizer_project_jobs")


def test_pull_lands_from_a_live_provider(
    customer_api: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A Braintrust pull uses the connector and lands as telemetry."""
    observed = _OnePageConnector(TraceTransportKind.BRAINTRUST)
    _stub_registry(monkeypatch, observed=observed)
    response = customer_api.post(
        _PULL,
        json={
            "transport_kind": "braintrust",
            "source_kind": "braintrust",
            "source_label": "braintrust-prod",
            "credential": "bt-secret",
            "config": {"project": "support"},
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["trace_count"] == 2
    assert observed.credentials == ["bt-secret"]

    summary = customer_api.get(_LIST).json()
    assert summary["total_traces"] == 2
    assert summary["traces"][0]["provider"] == "braintrust"


def test_pull_rejects_the_upload_transport(customer_api: TestClient) -> None:
    """transport_kind 'upload' is not a live pull."""
    response = customer_api.post(
        _PULL,
        json={
            "transport_kind": "upload",
            "source_kind": "otlp",
            "source_label": "nope",
            "credential": "x",
        },
    )
    assert response.status_code == 422, response.text


def test_normalized_span_read_is_disabled_until_explicitly_activated(
    customer_api: TestClient,
    supabase: FakeSupabaseClient,
) -> None:
    """A finalized receipt does not silently activate a production read path."""
    ticket = _create_upload(customer_api, label="prod")
    ingest_id = str(ticket["ingest_id"])
    record = TraceIngestStore(supabase).get_ingest(ingest_id)
    assert record is not None
    _put(supabase, record.upload_path or "", b'{"trace_id":"a"}\n')
    _finalize(customer_api, ingest_id)

    response = customer_api.get(f"{_LIST}/{ingest_id}/spans")

    assert response.status_code == 503, response.text


def test_normalized_span_read_is_tenant_scoped_and_clickhouse_backed(
    customer_api: TestClient,
    supabase: FakeSupabaseClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The opt-in analytical endpoint reads normalized rows, never raw bytes."""
    ticket = _create_upload(customer_api, label="prod")
    ingest_id = str(ticket["ingest_id"])
    record = TraceIngestStore(supabase).get_ingest(ingest_id)
    assert record is not None
    _put(supabase, record.upload_path or "", b'{"trace_id":"a"}\n')
    _finalize(customer_api, ingest_id)
    calls: list[dict[str, object]] = []

    class _Settings:
        """Read-enabled settings sentinel."""

        read_enabled = True

    class _Store:
        """ClickHouse reader capturing tenant filters."""

        def __init__(self, _settings: object) -> None:
            """Accept the settings sentinel."""

        def list_ingest(self, **kwargs: object) -> tuple[dict[str, object], ...]:
            """Return one normalized row."""
            calls.append(kwargs)
            return (
                {
                    "record_index": 0,
                    "event_type": "span",
                    "trace_id": "trace-a",
                    "span_id": "span-a",
                    "parent_span_id": None,
                    "name": "chat",
                    "span_kind": "client",
                    "status": "ok",
                    "started_at_ns": 1,
                    "duration_ns": 2,
                    "model": "gpt-test",
                    "input_tokens": 3,
                    "output_tokens": 4,
                    "attributes_json": '{"service.name":"gateway"}',
                },
            )

    monkeypatch.setattr(
        routes_module.ClickHouseTraceSettings,
        "from_env",
        classmethod(lambda _cls: _Settings()),
    )
    monkeypatch.setattr(routes_module, "ClickHouseTraceStore", _Store)

    response = customer_api.get(f"{_LIST}/{ingest_id}/spans?limit=10&offset=0")

    assert response.status_code == 200, response.text
    assert response.json()["spans"][0]["attributes"] == {"service.name": "gateway"}
    assert calls == [
        {
            "org_id": ORG_ID,
            "ingest_id": ingest_id,
            "projection_version": 1,
            "limit": 10,
            "offset": 0,
        }
    ]
