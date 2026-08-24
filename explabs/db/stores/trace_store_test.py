# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the trace upload store."""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.trace_store import (
    TraceStore,
    TraceUploadRecord,
    TraceUploadStatus,
    parse_trace_upload_status,
)
from explabs.db.stores.transitions import StateTransitionError


def _store() -> tuple[TraceStore, FakeSupabaseClient]:
    client = FakeSupabaseClient()
    return TraceStore(client), client


def _create(store: TraceStore, *, world_model_id: str | None = "wm-1") -> TraceUploadRecord:
    return store.create_upload(
        org_id="org-1",
        world_model_id=world_model_id,
        filename="traces.jsonl",
        storage_path="org-1/proj-1/traces/traces.jsonl",
        byte_size=1024,
        sha256="abc123",
    )


def test_create_upload_and_get_round_trip() -> None:
    """Created uploads read back as typed records in uploaded status."""
    store, _ = _store()

    created = _create(store)
    fetched = store.get(created.id)

    assert fetched == created
    assert fetched.status is TraceUploadStatus.UPLOADED
    assert fetched.adapter == "otel-genai"
    assert fetched.trace_count is None
    assert fetched.step_count is None


def test_create_upload_allows_unassigned_world_model() -> None:
    """Uploads may exist before a world model is chosen."""
    store, _ = _store()

    created = _create(store, world_model_id=None)

    assert created.world_model_id is None


def test_list_for_world_model_filters_and_orders_newest_first() -> None:
    """Listing scopes to the world model, newest first."""
    store, client = _store()
    first = _create(store)
    client.tables["trace_uploads"][0]["created_at"] = "2026-01-01T00:00:00+00:00"
    second = _create(store)
    _create(store, world_model_id="wm-other")

    listed = store.list_for_world_model("wm-1")

    assert [record.id for record in listed] == [second.id, first.id]


def test_all_for_world_model_pages_past_postgrest_row_cap() -> None:
    """Destructive cleanup reads every trace even beyond the 1,000-row cap."""
    store, client = _store()
    client.tables["trace_uploads"] = [
        {
            "id": f"upload-{index:04d}",
            "org_id": "org-1",
            "project_id": "proj-1",
            "world_model_id": "wm-1",
            "filename": f"{index:04d}.jsonl",
            "storage_path": f"traces/wm-1/{index:04d}.jsonl",
            "byte_size": 1,
            "sha256": "abc123",
            "adapter": "otel-genai",
            "trace_count": 1,
            "step_count": 1,
            "status": "ingested",
            "created_at": "2026-01-01T00:00:00+00:00",
        }
        for index in range(1_001)
    ]

    records = store.all_for_world_model("wm-1")

    assert len(records) == 1_001
    assert client.executed_selects.count("trace_uploads") == 2


def test_mark_ingested_sets_counts_and_requires_uploaded_status() -> None:
    """Ingestion records counts once and rejects repeat transitions."""
    store, _ = _store()
    created = _create(store)

    ingested = store.mark_ingested(created.id, trace_count=12, step_count=340)

    assert ingested.status is TraceUploadStatus.INGESTED
    assert ingested.trace_count == 12
    assert ingested.step_count == 340
    with pytest.raises(StateTransitionError, match="'ingested'"):
        store.mark_ingested(created.id, trace_count=1, step_count=1)


def test_mark_failed_requires_uploaded_status() -> None:
    """Failure is a terminal transition out of uploaded only."""
    store, _ = _store()
    created = _create(store)

    failed = store.mark_failed(created.id)

    assert failed.status is TraceUploadStatus.FAILED
    with pytest.raises(StateTransitionError, match="'failed'"):
        store.mark_failed(created.id)


def test_parse_status_rejects_unknown_values() -> None:
    """Unknown persisted statuses fail at the parse boundary."""
    store, client = _store()
    created = _create(store)
    client.tables["trace_uploads"][0]["status"] = "pending"

    with pytest.raises(ValueError, match="unknown trace upload status"):
        store.get(created.id)
    with pytest.raises(ValueError, match="unknown trace upload status"):
        parse_trace_upload_status(42)
