# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the trace-ingest store (fake Supabase; the routes add end-to-end coverage)."""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.stores.trace_ingest_store import (
    TraceIngestStatus,
    TraceIngestStore,
    TraceProjectionStatus,
)
from explabs.db.stores.trace_projection_store import TraceProjectionStore


def test_upsert_connection_rotates_in_place() -> None:
    """A second upsert for the same (org, kind) rotates the secret, not a new row."""
    client = FakeSupabaseClient()
    client.tables["organizations"] = [{"id": "org-1"}]
    store = TraceIngestStore(client)

    first = store.upsert_connection(
        org_id="org-1", kind="langfuse", config={"host": "h1"}, credential="pk:sk-one"
    )
    second = store.upsert_connection(
        org_id="org-1", kind="langfuse", config={"host": "h2"}, credential="pk:sk-two"
    )

    assert second.id == first.id
    assert len(client.tables["trace_connections"]) == 1
    assert second.config == {"host": "h2"}
    assert store.release_credential(first.id) == "pk:sk-two"


def test_find_connection_returns_none_when_absent() -> None:
    """No stored connection for a kind yields None, not an error."""
    client = FakeSupabaseClient()
    assert TraceIngestStore(client).find_connection("org-1", "posthog") is None


def test_list_connections_is_org_scoped_and_credential_free() -> None:
    """Connection inventory returns typed metadata for only the requested org."""
    client = FakeSupabaseClient()
    client.tables["organizations"] = [{"id": "org-1"}, {"id": "org-2"}]
    store = TraceIngestStore(client)
    store.upsert_connection(
        org_id="org-1",
        kind="langsmith",
        config={"host": "https://safe.example"},
        credential="super-secret-one",
    )
    store.upsert_connection(org_id="org-2", kind="posthog", config={}, credential="foreign")

    connections = store.list_connections("org-1")

    assert [connection.kind for connection in connections] == ["langsmith"]
    assert connections[0].config == {"host": "https://safe.example"}
    assert "super-secret-one" not in connections[0].model_dump_json()


def test_release_credential_fails_loudly_for_unknown_connection() -> None:
    """Releasing a missing connection's credential is a loud failure."""
    client = FakeSupabaseClient()
    with pytest.raises(RuntimeError, match="not found"):
        TraceIngestStore(client).release_credential("no-such-connection")


def test_ingest_lifecycle_round_trips_statuses() -> None:
    """Pending -> claim -> done, with the terminal fields persisted for replay."""
    client = FakeSupabaseClient()
    store = TraceIngestStore(client)
    ingest = store.create_ingest(org_id="org-1", source={"kind": "file", "filename": "x"})
    assert ingest.status is TraceIngestStatus.PENDING

    assert store.claim_pending(ingest.id) is True
    assert store.claim_pending(ingest.id) is False

    store.mark_done(
        ingest.id,
        result_path="ingests/org-1/x.otel.jsonl",
        trace_count=3,
        step_count=9,
        trace_upload_id="tu-1",
    )
    reloaded = store.get_ingest(ingest.id)
    assert reloaded is not None
    assert reloaded.status is TraceIngestStatus.DONE
    assert reloaded.result_path == "ingests/org-1/x.otel.jsonl"
    assert reloaded.trace_upload_id == "tu-1"


def _ingest_row(
    ingest_id: str, wm_id: str | None, org_id: str, created_at: str
) -> dict[str, object]:
    """Build one seeded ``trace_ingests`` row for the batch-read tests."""
    return {
        "id": ingest_id,
        "org_id": org_id,
        "world_model_id": wm_id,
        "connection_id": None,
        "source": {"kind": "file"},
        "status": "done",
        "created_at": created_at,
    }


def test_latest_for_world_models_newest_wins_and_skips_unowned_rows() -> None:
    """The newest row per model wins; null-model and foreign-org rows are ignored."""
    client = FakeSupabaseClient()
    client.tables["trace_ingests"] = [
        _ingest_row("ing-old", "wm-1", "org-1", "2026-07-26T00:00:00Z"),
        _ingest_row("ing-new", "wm-1", "org-1", "2026-07-27T00:00:00Z"),
        _ingest_row("ing-orphan", None, "org-1", "2026-07-27T01:00:00Z"),
        _ingest_row("ing-foreign", "wm-1", "org-2", "2026-07-27T02:00:00Z"),
    ]
    store = TraceIngestStore(client)

    latest = store.latest_for_world_models(["wm-1"], org_id="org-1")

    assert set(latest) == {"wm-1"}
    assert latest["wm-1"].id == "ing-new"


def test_latest_for_world_models_short_circuits_on_empty_input() -> None:
    """No ids means no query and an empty result."""
    client = FakeSupabaseClient()
    assert TraceIngestStore(client).latest_for_world_models([], org_id="org-1") == {}


def test_create_ingest_honors_caller_chosen_id() -> None:
    """Signed-upload reservations pin the ingest id into the object path."""
    client = FakeSupabaseClient()
    record = TraceIngestStore(client).create_ingest(
        org_id="org-1",
        source={"kind": "file"},
        ingest_id="aa000000-0000-0000-0000-000000000001",
        upload_path="orgs/org-1/telemetry-traces/otlp/aa000000-0000-0000-0000-000000000001/n",
    )
    assert record.id == "aa000000-0000-0000-0000-000000000001"
    assert record.upload_path is not None
    assert record.id in record.upload_path


def test_accept_telemetry_ingest_is_idempotent() -> None:
    """A second accept of the same pending ingest does not duplicate the job."""
    client = FakeSupabaseClient()
    store = TraceIngestStore(client)
    ingest = store.create_ingest(
        org_id="org-1",
        source={"kind": "file"},
        upload_path="orgs/org-1/telemetry-traces/otlp/x/y",
    )
    first = store.accept_telemetry_ingest(ingest.id)
    second = store.accept_telemetry_ingest(ingest.id)
    assert first.status is TraceIngestStatus.RUNNING
    assert second.status is TraceIngestStatus.RUNNING
    assert len(client.tables["trace_clickhouse_projections"]) == 1


def test_ack_marks_router_free_running_ingest_done() -> None:
    """Claim-fenced projection ack is what public polling observes as done."""
    client = FakeSupabaseClient()
    store = TraceIngestStore(client)
    ingest = store.create_ingest(
        org_id="org-1",
        source={"kind": "file"},
        upload_path="orgs/org-1/telemetry-traces/otlp/x/y",
    )
    store.accept_telemetry_ingest(ingest.id)
    queue = TraceProjectionStore(client)
    (job,) = queue.claim("worker-ack", limit=1)
    running = store.get_ingest(ingest.id)
    assert running is not None
    assert running.status is TraceIngestStatus.RUNNING
    assert queue.ack(job, projected_rows=2) is True
    done = store.get_ingest(ingest.id)
    assert done is not None
    assert done.status is TraceIngestStatus.DONE
    assert done.trace_projection_status is TraceProjectionStatus.DONE
    assert done.trace_projected_rows == 2


def test_ack_leaves_project_and_remote_ingest_status_unchanged() -> None:
    """Project rows and already-done remote receipts keep their ingest status."""
    client = FakeSupabaseClient()
    store = TraceIngestStore(client)
    project = store.create_ingest(
        org_id="org-1",
        source={"kind": "file"},
        world_model_id="wm-1",
        upload_path="orgs/org-1/projects/wm-1/traces",
    )
    assert store.claim_pending(project.id) is True
    client.tables.setdefault("trace_clickhouse_projections", []).append(
        {
            "ingest_id": project.id,
            "org_id": "org-1",
            "projection_version": 1,
            "state": "pending",
            "attempts": 0,
        }
    )
    remote = store.create_ingest(
        org_id="org-1",
        source={"kind": "provider"},
        upload_path="orgs/org-1/telemetry-traces/otlp/remote",
    )
    store.complete_telemetry_ingest(
        remote.id,
        result_path="orgs/org-1/telemetry-traces/otlp/remote",
        trace_count=1,
        byte_size=12,
        object_sha256="b" * 64,
    )
    queue = TraceProjectionStore(client)
    jobs = queue.claim("worker-ack", limit=2)
    assert {job.ingest_id for job in jobs} == {project.id, remote.id}
    for job in jobs:
        assert queue.ack(job, projected_rows=1) is True
    project_done = store.get_ingest(project.id)
    remote_done = store.get_ingest(remote.id)
    assert project_done is not None
    assert project_done.status is TraceIngestStatus.RUNNING
    assert project_done.trace_projection_status is TraceProjectionStatus.DONE
    assert remote_done is not None
    assert remote_done.status is TraceIngestStatus.DONE
    assert remote_done.trace_projection_status is TraceProjectionStatus.DONE
