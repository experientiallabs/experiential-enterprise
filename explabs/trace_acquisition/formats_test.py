# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for Project trace upload declarations and byte validation."""

from __future__ import annotations

import json

import pytest

from explabs.trace_acquisition.formats import (
    MAX_TRACE_OBJECT_BYTES,
    TRACE_UPLOAD_FORMATS,
    TraceUploadFormat,
    TraceUploadValidationError,
    canonical_jsonl,
    validate_source_label,
    validate_trace_upload,
)


def test_upload_registry_is_exactly_the_nine_wmo_file_sources() -> None:
    """The public registry includes Phoenix but no Postgres file fiction."""
    assert tuple(source.value for source in TRACE_UPLOAD_FORMATS) == (
        "braintrust",
        "chat-json",
        "langfuse",
        "langsmith",
        "mastra",
        "otel-genai",
        "otlp",
        "phoenix",
        "posthog",
    )
    assert "postgres" not in {source.value for source in TraceUploadFormat}


@pytest.mark.parametrize("source", TRACE_UPLOAD_FORMATS)
def test_every_declared_upload_format_accepts_immutable_json_bytes(
    source: TraceUploadFormat,
) -> None:
    """Platform accepts each declared file format without importing WMO."""
    content = json.dumps({"source": source.value, "records": [{"id": "one"}]}).encode()

    validated = validate_trace_upload(content, content_type="application/json; charset=utf-8")

    assert validated.content_type == "application/json"
    assert validated.record_count_estimate == 1


def test_jsonl_validation_counts_records_and_canonicalizes_remote_bytes() -> None:
    """JSONL counts and remote serialization are deterministic."""
    content = b'{"id":2}\n{"id":1}\n'
    assert (
        validate_trace_upload(content, content_type="application/x-ndjson").record_count_estimate
        == 2
    )
    assert canonical_jsonl([{"b": 2, "a": 1}]) == b'{"a":1,"b":2}\n'


@pytest.mark.parametrize(
    ("content", "content_type"),
    [
        (b"", "application/json"),
        (b"not-json", "application/json"),
        (b"42", "application/json"),
        (b'{"value":NaN}', "application/json"),
        (b'{"ok":true}', "image/png"),
        (b"\x00binary", "application/octet-stream"),
        (b'{"ok":true}\ntruncated', "application/x-ndjson"),
    ],
)
def test_unsupported_or_malformed_uploads_fail_closed(
    content: bytes,
    content_type: str,
) -> None:
    """Unsupported media and malformed bytes never reach object storage."""
    with pytest.raises(TraceUploadValidationError):
        validate_trace_upload(content, content_type=content_type)


def test_object_cap_is_exactly_fifty_mebibytes() -> None:
    """The published object limit rejects the first byte beyond 50 MiB."""
    oversized = b" " * (MAX_TRACE_OBJECT_BYTES + 1)
    with pytest.raises(TraceUploadValidationError, match="object limit"):
        validate_trace_upload(oversized, content_type="application/json")


@pytest.mark.parametrize(
    "label",
    [
        "/tmp/export.json",  # noqa: S108 - intentionally hostile durable label
        "~/trace.jsonl",
        "C:\\trace.json",
        "../../secret",
        "folder/file",
    ],
)
def test_durable_source_label_rejects_worker_and_user_paths(label: str) -> None:
    """A WMO identity label can never inherit a machine-local path."""
    with pytest.raises(TraceUploadValidationError, match="path"):
        validate_source_label(label)


def test_durable_source_label_is_trimmed_customer_text() -> None:
    """Ordinary customer-facing labels are normalized once before persistence."""
    assert validate_source_label("  Support production traces  ") == "Support production traces"


def test_durable_source_label_rejects_invisible_direction_controls() -> None:
    """Unicode format controls cannot make a persisted label visually deceptive."""
    with pytest.raises(TraceUploadValidationError, match="control"):
        validate_source_label("production\N{RIGHT-TO-LEFT OVERRIDE}nosj.exe")
