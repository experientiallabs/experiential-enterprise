# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the two-phase org telemetry upload client."""

from __future__ import annotations

import httpx
import pytest

from explabs.trace_acquisition.formats import TraceUploadFormat
from explabs.trace_acquisition.telemetry_ingest import STORAGE_TRACE_CONTENT_TYPE
from explabs.trace_acquisition.telemetry_upload_client import TelemetryTraceUploadClient


def test_upload_creates_puts_raw_bytes_and_finalizes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The client never posts multipart bytes to the control API."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/telemetry/traces/upload"):
            assert request.headers["authorization"] == "Bearer xpl_test"
            assert b"service_role" not in request.content
            return httpx.Response(
                201,
                json={
                    "ingest_id": "ing-1",
                    "source_kind": "otlp",
                    "source_label": "prod",
                    "signed_url": "https://storage.example/object/upload/sign/b/p?token=t",
                    "token": "t",
                    "expires_in": 7200,
                    "method": "PUT",
                },
            )
        if request.url.path.endswith("/finalize"):
            return httpx.Response(
                202,
                json={"ingest_id": "ing-1", "status": "accepted", "projection_status": "pending"},
            )
        raise AssertionError(f"unexpected control request {request.url}")

    puts: list[dict[str, object]] = []

    def fake_put(url: str, **kwargs: object) -> httpx.Response:
        puts.append({"url": url, **kwargs})
        return httpx.Response(200, request=httpx.Request("PUT", url))

    monkeypatch.setattr("explabs.persistence.object_storage.httpx.put", fake_put)
    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http:
        accepted = TelemetryTraceUploadClient(
            http,
            api_base_url="https://api.example",
            api_key="xpl_test",
        ).upload(
            org_id="org-1",
            source_kind=TraceUploadFormat.OTLP,
            source_label="prod",
            content=b'{"trace_id":"a"}\n',
        )

    assert accepted.ingest_id == "ing-1"
    assert accepted.status == "accepted"
    (put,) = puts
    assert put["url"] == "https://storage.example/object/upload/sign/b/p?token=t"
    assert put["content"] == b'{"trace_id":"a"}\n'
    assert "files" not in put
    assert put["headers"] == {"content-type": STORAGE_TRACE_CONTENT_TYPE}
