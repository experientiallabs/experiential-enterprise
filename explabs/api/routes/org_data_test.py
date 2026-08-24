# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the retained org-scoped legacy world-model wipe."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from explabs.api.routes import ApiError
from explabs.api.routes.org_data import router
from explabs.db.fake_supabase_test import FakeSupabaseClient

_ORG_ID = "00000000-0000-0000-0000-000000000001"
_OTHER_ORG_ID = "00000000-0000-0000-0000-000000000002"
_ACTOR_ID = "00000000-0000-0000-0000-000000000003"
_WM_ID = "00000000-0000-0000-0000-000000000011"
_OTHER_WM_ID = "00000000-0000-0000-0000-000000000012"
_CATALOG_ENTRY_ID = "00000000-0000-0000-0000-000000000021"

_ARTIFACT_BUCKET = "explabs-artifacts"
_ARTIFACT_PATH = f"world-models/{_WM_ID}/bundle.tar"
_TRACE_PATH = f"world-models/{_WM_ID}/traces.jsonl"
_SHARED_CATALOG_TRACE_PATH = "catalog/shared-traces.jsonl"


def _world_model_row(*, wm_id: str = _WM_ID, org_id: str = _ORG_ID) -> dict[str, object]:
    """Return one minimal legacy world-model row."""
    return {"id": wm_id, "org_id": org_id, "catalog_entry_id": None}


def _artifact_row(*, wm_id: str = _WM_ID) -> dict[str, object]:
    """Return one artifact row pointing at a stored bundle object."""
    return {
        "id": "00000000-0000-0000-0000-000000000031",
        "org_id": _ORG_ID,
        "world_model_id": wm_id,
        "kind": "world_model_bundle",
        "storage_bucket": _ARTIFACT_BUCKET,
        "storage_path": _ARTIFACT_PATH,
        "byte_size": 4,
        "sha256": "a" * 64,
        "created_at": "2026-08-17T00:00:00+00:00",
    }


def _trace_upload_row(*, wm_id: str = _WM_ID, storage_path: str = _TRACE_PATH) -> dict[str, object]:
    """Return one trace-upload row pointing at a stored trace object."""
    return {
        "id": "00000000-0000-0000-0000-000000000041",
        "org_id": _ORG_ID,
        "world_model_id": wm_id,
        "filename": "traces.jsonl",
        "storage_path": storage_path,
        "byte_size": 4,
        "sha256": "b" * 64,
        "adapter": "otlp",
        "trace_count": 1,
        "step_count": 1,
        "status": "ingested",
        "created_at": "2026-08-17T00:00:00+00:00",
    }


def _catalog_entry_row() -> dict[str, object]:
    """Return one catalog entry whose shared trace object must survive."""
    return {
        "id": _CATALOG_ENTRY_ID,
        "name": "starter",
        "display_name": None,
        "description": None,
        "serve_provider": "openai",
        "serve_model": "frontier",
        "embed_provider": None,
        "embed_dim": None,
        "trace_adapter": "otlp",
        "config": {},
        "metrics": None,
        "trace_count": 1,
        "step_count": 1,
        "storage_bucket": _ARTIFACT_BUCKET,
        "storage_path": "catalog/bundle.tar",
        "byte_size": 4,
        "sha256": "c" * 64,
        "import_count": 1,
        "traces_filename": "shared.jsonl",
        "traces_storage_path": _SHARED_CATALOG_TRACE_PATH,
        "traces_byte_size": 4,
        "traces_sha256": "d" * 64,
        "source_world_model_id": None,
        "scenario_set": None,
        "deprecated_at": None,
        "created_at": "2026-08-17T00:00:00+00:00",
    }


def _api(supabase: FakeSupabaseClient, *, actor_role: str = "admin") -> TestClient:
    """Return the wipe router mounted like production, with one org member."""
    supabase.tables.setdefault("organizations", [{"id": _ORG_ID}, {"id": _OTHER_ORG_ID}])
    supabase.tables.setdefault(
        "organization_members", [{"org_id": _ORG_ID, "user_id": _ACTOR_ID, "role": actor_role}]
    )
    supabase.tables.setdefault("platform_admins", [])
    supabase.tables.setdefault("agents", [])
    supabase.tables.setdefault("agent_sessions", [])
    supabase.tables.setdefault("artifacts", [])
    supabase.tables.setdefault("trace_uploads", [])
    supabase.tables.setdefault("storage_cleanup_jobs", [])
    app = FastAPI()
    app.state.supabase_client = supabase
    app.include_router(router)

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, error: ApiError) -> JSONResponse:
        """Render route errors like the production app."""
        return JSONResponse({"error": str(error)}, status_code=error.status_code)

    return TestClient(app, headers={"X-Explabs-Actor-Id": _ACTOR_ID})


def _store_object(supabase: FakeSupabaseClient, bucket: str, path: str) -> None:
    """Seed one fake stored object so removal is observable."""
    supabase.fake_storage.uploads[(bucket, path)] = b"data"


def test_wipe_deletes_rows_objects_and_outbox() -> None:
    """The wipe removes the org's models, their objects, and the staged jobs."""
    supabase = FakeSupabaseClient()
    supabase.tables["world_models"] = [
        _world_model_row(),
        _world_model_row(wm_id=_OTHER_WM_ID, org_id=_OTHER_ORG_ID),
    ]
    supabase.tables["artifacts"] = [_artifact_row()]
    supabase.tables["trace_uploads"] = [_trace_upload_row()]
    api = _api(supabase)
    _store_object(supabase, _ARTIFACT_BUCKET, _ARTIFACT_PATH)
    _store_object(supabase, _ARTIFACT_BUCKET, _TRACE_PATH)

    response = api.delete(f"/api/orgs/{_ORG_ID}/data")

    assert response.status_code == 200
    assert response.json() == {"deleted_world_models": 1}
    remaining = [row["id"] for row in supabase.tables["world_models"]]
    assert remaining == [_OTHER_WM_ID]
    assert (_ARTIFACT_BUCKET, _ARTIFACT_PATH) not in supabase.fake_storage.uploads
    assert (_ARTIFACT_BUCKET, _TRACE_PATH) not in supabase.fake_storage.uploads
    assert supabase.tables["storage_cleanup_jobs"] == []


def test_wipe_preserves_shared_catalog_trace_object() -> None:
    """A catalog import's shared trace bytes survive the importing org's wipe."""
    supabase = FakeSupabaseClient()
    row = _world_model_row()
    row["catalog_entry_id"] = _CATALOG_ENTRY_ID
    supabase.tables["world_models"] = [row]
    supabase.tables["wm_catalog_entries"] = [_catalog_entry_row()]
    supabase.tables["trace_uploads"] = [_trace_upload_row(storage_path=_SHARED_CATALOG_TRACE_PATH)]
    api = _api(supabase)
    _store_object(supabase, _ARTIFACT_BUCKET, _SHARED_CATALOG_TRACE_PATH)

    response = api.delete(f"/api/orgs/{_ORG_ID}/data")

    assert response.status_code == 200
    assert supabase.tables["world_models"] == []
    assert (_ARTIFACT_BUCKET, _SHARED_CATALOG_TRACE_PATH) in supabase.fake_storage.uploads


def test_wipe_with_no_legacy_models_reports_zero() -> None:
    """An org with no legacy world models gets a clean zero, not an error."""
    supabase = FakeSupabaseClient()
    supabase.tables["world_models"] = []
    api = _api(supabase)

    response = api.delete(f"/api/orgs/{_ORG_ID}/data")

    assert response.status_code == 200
    assert response.json() == {"deleted_world_models": 0}


def test_wipe_requires_admin_role() -> None:
    """A plain member cannot run the wipe."""
    supabase = FakeSupabaseClient()
    supabase.tables["world_models"] = [_world_model_row()]
    api = _api(supabase, actor_role="user")

    response = api.delete(f"/api/orgs/{_ORG_ID}/data")

    assert response.status_code == 403
    assert len(supabase.tables["world_models"]) == 1


def test_wipe_hides_other_tenants() -> None:
    """A non-member sees the same 404 as an absent organization."""
    supabase = FakeSupabaseClient()
    supabase.tables["world_models"] = [_world_model_row(wm_id=_OTHER_WM_ID, org_id=_OTHER_ORG_ID)]
    api = _api(supabase)

    response = api.delete(f"/api/orgs/{_OTHER_ORG_ID}/data")

    assert response.status_code == 404
    assert len(supabase.tables["world_models"]) == 1


def test_wipe_emits_an_audit_event() -> None:
    """The destructive wipe records one org.data_delete audit event."""
    supabase = FakeSupabaseClient()
    api = _api(supabase)
    response = api.delete(f"/api/orgs/{_ORG_ID}/data")
    assert response.status_code == 200
    assert supabase.executed_rpcs.count("record_audit_event") == 1
