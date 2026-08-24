# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the built-bundle artifact metadata store."""

from __future__ import annotations

import pytest

from explabs.db.fake_supabase_test import FakeSupabaseClient
from explabs.db.repositories import RepositoryError
from explabs.db.stores.artifact_store import (
    DEFAULT_STORAGE_BUCKET,
    ArtifactKind,
    ArtifactRecord,
    ArtifactStore,
    parse_artifact_kind,
)

_SHA256 = "a" * 64


def _store() -> tuple[ArtifactStore, FakeSupabaseClient]:
    client = FakeSupabaseClient()
    return ArtifactStore(client), client


def test_create_and_get_round_trip() -> None:
    """Created artifacts read back as typed records with the default bucket."""
    store, _ = _store()

    created = store.create(
        org_id="org-1",
        kind=ArtifactKind.WORLD_MODEL_BUNDLE,
        storage_path="models/wm-1/bundle.tar.gz",
        byte_size=1024,
        sha256=_SHA256,
        world_model_id="wm-1",
    )
    fetched = store.get(created.id)

    assert isinstance(fetched, ArtifactRecord)
    assert fetched == created
    assert fetched.kind is ArtifactKind.WORLD_MODEL_BUNDLE
    assert fetched.storage_bucket == DEFAULT_STORAGE_BUCKET
    assert fetched.storage_path == "models/wm-1/bundle.tar.gz"
    assert fetched.byte_size == 1024
    assert fetched.sha256 == _SHA256
    assert fetched.world_model_id == "wm-1"
    assert fetched.agent_opt_run_id is None


def test_create_rejects_invalid_metadata() -> None:
    """Negative sizes and empty path/digest fail before any write."""
    store, client = _store()

    with pytest.raises(ValueError, match="byte_size"):
        store.create(
            org_id="org-1",
            kind=ArtifactKind.WORLD_MODEL_BUNDLE,
            storage_path="models/wm-1/bundle.tar.gz",
            byte_size=-1,
            sha256=_SHA256,
        )
    with pytest.raises(ValueError, match="storage_path"):
        store.create(
            org_id="org-1",
            kind=ArtifactKind.WORLD_MODEL_BUNDLE,
            storage_path="",
            byte_size=1,
            sha256=_SHA256,
        )
    with pytest.raises(ValueError, match="sha256"):
        store.create(
            org_id="org-1",
            kind=ArtifactKind.WORLD_MODEL_BUNDLE,
            storage_path="models/wm-1/bundle.tar.gz",
            byte_size=1,
            sha256="",
        )
    assert client.tables.get("artifacts", []) == []


def test_get_for_world_model_returns_newest_or_none() -> None:
    """Lookup by world model returns the newest bundle, or None when unbuilt."""
    store, client = _store()
    store.create(
        org_id="org-1",
        kind=ArtifactKind.WORLD_MODEL_BUNDLE,
        storage_path="models/wm-1/bundle-v1.tar.gz",
        byte_size=1,
        sha256=_SHA256,
        world_model_id="wm-1",
    )
    # Force distinct created_at values so ordering is deterministic.
    client.tables["artifacts"][0]["created_at"] = "2026-01-01T00:00:00+00:00"
    newest = store.create(
        org_id="org-1",
        kind=ArtifactKind.WORLD_MODEL_BUNDLE,
        storage_path="models/wm-1/bundle-v2.tar.gz",
        byte_size=2,
        sha256=_SHA256,
        world_model_id="wm-1",
    )

    assert store.get_for_world_model("wm-1") == newest
    assert store.get_for_world_model("wm-unbuilt") is None


def test_get_for_world_model_ignores_task_embeddings_artifacts() -> None:
    """A newer embeddings artifact never shadows the model's bundle."""
    store, client = _store()
    bundle = store.create(
        org_id="org-1",
        kind=ArtifactKind.WORLD_MODEL_BUNDLE,
        storage_path="models/wm-1/bundle.tar.gz",
        byte_size=1,
        sha256=_SHA256,
        world_model_id="wm-1",
    )
    client.tables["artifacts"][0]["created_at"] = "2026-01-01T00:00:00+00:00"
    embeddings = store.create(
        org_id="org-1",
        kind=ArtifactKind.TASK_EMBEDDINGS,
        storage_path="agent-runs/run-1/task-embeddings.json",
        byte_size=2,
        sha256=_SHA256,
        world_model_id="wm-1",
    )

    found = store.get_for_world_model("wm-1")
    assert found is not None
    assert found.id == bundle.id  # the (newer) embeddings artifact is filtered out
    assert embeddings.kind is ArtifactKind.TASK_EMBEDDINGS
    assert parse_artifact_kind("task_embeddings") is ArtifactKind.TASK_EMBEDDINGS


def test_all_for_world_model_pages_past_postgrest_row_cap() -> None:
    """Destructive cleanup reads every bundle even beyond the 1,000-row cap."""
    store, client = _store()
    client.tables["artifacts"] = [
        {
            "id": f"artifact-{index:04d}",
            "org_id": "org-1",
            "project_id": "proj-1",
            "world_model_id": "wm-1",
            "kind": "world_model_bundle",
            "storage_bucket": DEFAULT_STORAGE_BUCKET,
            "storage_path": f"models/wm-1/{index:04d}.tar.gz",
            "byte_size": 1,
            "sha256": _SHA256,
            "created_at": "2026-01-01T00:00:00+00:00",
        }
        for index in range(1_001)
    ]

    records = store.all_for_world_model("wm-1")

    assert len(records) == 1_001
    assert client.executed_selects.count("artifacts") == 2


def test_get_missing_artifact_fails_loudly() -> None:
    """Fetching an unknown identifier raises."""
    store, _ = _store()

    with pytest.raises(RepositoryError, match="no rows"):
        store.get("missing")


def test_parse_kind_rejects_unknown_values() -> None:
    """Unknown persisted kinds fail at the parse boundary."""
    store, client = _store()
    created = store.create(
        org_id="org-1",
        kind=ArtifactKind.WORLD_MODEL_BUNDLE,
        storage_path="models/wm-1/bundle.tar.gz",
        byte_size=1,
        sha256=_SHA256,
    )
    client.tables["artifacts"][0]["kind"] = "screenshot"

    with pytest.raises(ValueError, match="unknown artifact kind"):
        store.get(created.id)
    with pytest.raises(ValueError, match="unknown artifact kind"):
        parse_artifact_kind(None)
