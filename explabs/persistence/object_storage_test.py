# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the current Platform object-storage boundary."""

from __future__ import annotations

from pathlib import Path
from typing import cast

import httpx
import pytest

from explabs.db.repositories import SupabaseClient
from explabs.persistence.object_storage import (
    SIGNED_UPLOAD_EXPIRES_IN,
    create_signed_upload,
    storage_bucket,
    upload_bytes_to_signed_url,
    upload_object_raw,
)


class _FakeHttpClient:
    """Record the request storage3's authenticated client would send."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def request(self, method: str, url: str, **kwargs: object) -> httpx.Response:
        """Record one request and return a successful response."""
        self.calls.append({"method": method, "url": url, **kwargs})
        return httpx.Response(200, request=httpx.Request(method, url))


class _Proxy:
    """Minimal storage3 bucket proxy for raw-upload and signed-upload tests."""

    def __init__(self, client: _FakeHttpClient) -> None:
        self._client = client
        self._base_url = "https://example.supabase.co/storage/v1/"
        self.signed_paths: list[str] = []

    def create_signed_upload_url(self, path: str) -> dict[str, str]:
        """Return an official-shaped signed upload payload for ``path``."""
        self.signed_paths.append(path)
        return {
            "signedUrl": f"https://example.supabase.co/storage/v1/object/upload/sign/explabs-artifacts/{path}?token=bound-token",
            "token": "bound-token",
            "path": path,
        }


class _Storage:
    """Minimal Supabase Storage facade for raw-upload tests."""

    def __init__(self, client: _FakeHttpClient) -> None:
        self._client = client
        self.proxy = _Proxy(client)

    def from_(self, bucket: str) -> _Proxy:
        """Return the test proxy for the expected private bucket."""
        assert bucket == "explabs-artifacts"
        return self.proxy


class _Client:
    """Minimal Supabase client exposing the Storage facade."""

    def __init__(self, http_client: _FakeHttpClient) -> None:
        self.storage = _Storage(http_client)


def test_storage_bucket_defaults_and_honors_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Current callers share one explicit bucket configuration contract."""
    monkeypatch.delenv("EXPLABS_STORAGE_BUCKET", raising=False)
    assert storage_bucket() == "explabs-artifacts"

    monkeypatch.setenv("EXPLABS_STORAGE_BUCKET", "project-artifacts")
    assert storage_bucket() == "project-artifacts"


def test_raw_upload_quotes_object_paths_and_avoids_multipart() -> None:
    """Customer-controlled path characters cannot alter the stored object key."""
    fake = _FakeHttpClient()
    upload_object_raw(
        cast("SupabaseClient", _Client(fake)),
        bucket="explabs-artifacts",
        path="projects/run #3?.jsonl",
        data=b'{"tool_call":"bash"}',
        content_type="application/octet-stream",
    )

    (call,) = fake.calls
    assert call["method"] == "POST"
    assert (
        call["url"] == "https://example.supabase.co/storage/v1/object/explabs-artifacts/"
        "projects/run%20%233%3F.jsonl"
    )
    assert call["content"] == b'{"tool_call":"bash"}'
    assert "files" not in call
    assert cast("dict[str, str]", call["headers"])["x-upsert"] == "true"


def test_production_storage_writes_never_use_multipart_upload() -> None:
    """All current server-side object writes use the raw upload boundary."""
    root = Path(__file__).resolve().parents[2] / "explabs"
    offenders = [
        str(path.relative_to(root.parent))
        for path in root.rglob("*.py")
        if not path.name.endswith("_test.py")
        and ".storage.from_(" in path.read_text(encoding="utf-8")
        and ").upload(" in path.read_text(encoding="utf-8")
    ]
    assert offenders == []


def test_create_signed_upload_returns_path_bound_ticket_without_upsert() -> None:
    """The mint uses Storage's default no-overwrite signed-upload contract."""
    http = _FakeHttpClient()
    storage = _Storage(http)
    client = _Client(http)
    client.storage = storage

    ticket = create_signed_upload(
        cast("SupabaseClient", client),
        bucket="explabs-artifacts",
        path="orgs/org-1/telemetry-traces/otlp/ingest/nonce",
    )

    assert ticket.token == "bound-token"
    assert ticket.path == "orgs/org-1/telemetry-traces/otlp/ingest/nonce"
    assert ticket.expires_in == SIGNED_UPLOAD_EXPIRES_IN
    assert ticket.signed_url.endswith("?token=bound-token")
    assert storage.proxy.signed_paths == [ticket.path]


def test_upload_bytes_to_signed_url_puts_raw_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The client consume path sends exact bytes, never multipart."""
    calls: list[dict[str, object]] = []

    def fake_put(url: str, **kwargs: object) -> httpx.Response:
        calls.append({"url": url, **kwargs})
        return httpx.Response(200, request=httpx.Request("PUT", url))

    monkeypatch.setattr(httpx, "put", fake_put)
    upload_bytes_to_signed_url(
        "https://example.supabase.co/storage/v1/object/upload/sign/b/p?token=t",
        b'{"trace_id":"a"}\n',
        content_type="application/octet-stream",
    )

    (call,) = calls
    url = call["url"]
    assert isinstance(url, str)
    assert url.endswith("?token=t")
    assert call["content"] == b'{"trace_id":"a"}\n'
    assert "files" not in call
    assert cast("dict[str, str]", call["headers"])["content-type"] == "application/octet-stream"
