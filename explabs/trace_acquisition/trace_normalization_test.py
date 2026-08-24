# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for lossless, query-oriented trace normalization."""

from __future__ import annotations

import hashlib
import json
from typing import TypedDict

import pytest

from explabs.trace_acquisition.trace_normalization import (
    TraceNormalizationError,
    normalize_trace_object,
)


class _BaseKwargs(TypedDict):
    """Typed normalization metadata shared by tests."""

    org_id: str
    ingest_id: str
    source_kind: str
    transport_kind: str
    source_label: str
    received_at: str
    projection_version: int
    projection_attempt: int


_BASE: _BaseKwargs = {
    "org_id": "71000000-0000-0000-0000-000000000001",
    "ingest_id": "72000000-0000-0000-0000-000000000001",
    "source_kind": "otlp",
    "transport_kind": "upload",
    "source_label": "production",
    "received_at": "2026-08-22T20:00:00+00:00",
    "projection_version": 1,
    "projection_attempt": 1,
}


def _normalize(content: bytes):  # noqa: ANN202 - inferred test helper
    """Normalize bytes with stable fixture metadata and their real digest."""
    return normalize_trace_object(
        content,
        object_sha256=hashlib.sha256(content, usedforsecurity=False).hexdigest(),
        **_BASE,
    )


def test_otlp_resource_spans_flatten_with_resource_and_scope_context() -> None:
    """OTLP envelopes become one row per span without dropping inherited fields."""
    content = json.dumps(
        {
            "resourceSpans": [
                {
                    "resource": {
                        "attributes": [
                            {
                                "key": "service.name",
                                "value": {"stringValue": "gateway"},
                            }
                        ]
                    },
                    "scopeSpans": [
                        {
                            "scope": {"name": "openinference", "version": "1.0"},
                            "spans": [
                                {
                                    "traceId": "trace-a",
                                    "spanId": "span-a",
                                    "parentSpanId": "parent-a",
                                    "name": "chat completion",
                                    "kind": "CLIENT",
                                    "startTimeUnixNano": "1000000000",
                                    "endTimeUnixNano": "1500000000",
                                    "status": {"code": "STATUS_CODE_OK"},
                                    "attributes": [
                                        {
                                            "key": "gen_ai.request.model",
                                            "value": {"stringValue": "gpt-test"},
                                        },
                                        {
                                            "key": "gen_ai.usage.input_tokens",
                                            "value": {"intValue": "120"},
                                        },
                                    ],
                                }
                            ],
                        }
                    ],
                }
            ]
        },
        separators=(",", ":"),
    ).encode()

    rows = _normalize(content)

    assert len(rows) == 1
    row = rows[0]
    assert row.event_type == "span"
    assert row.trace_id == "trace-a"
    assert row.span_id == "span-a"
    assert row.duration_ns == 500_000_000
    assert row.model == "gpt-test"
    assert row.input_tokens == 120
    assert json.loads(row.attributes_json) == {
        "gen_ai.request.model": "gpt-test",
        "gen_ai.usage.input_tokens": "120",
        "resource.service.name": "gateway",
        "scope.name": "openinference",
        "scope.version": "1.0",
    }


def test_jsonl_preserves_every_top_level_record_and_stable_identity() -> None:
    """JSONL records retain payloads and deterministic object-local identities."""
    content = b'{"trace_id":"a","span_id":"1"}\n{"trace_id":"b","span_id":"2"}\n'
    first = _normalize(content)
    second = _normalize(content)

    assert [row.record_index for row in first] == [0, 1]
    assert [row.payload_json for row in first] == [
        '{"span_id":"1","trace_id":"a"}',
        '{"span_id":"2","trace_id":"b"}',
    ]
    assert [row.event_id for row in first] == [row.event_id for row in second]


def test_generic_wrapper_retains_envelope_context_on_every_child() -> None:
    """Unwrapping a vendor array does not discard its enclosing metadata."""
    content = b'{"project":"support","environment":"prod","runs":[{"id":"r1"}]}'

    rows = _normalize(content)

    assert len(rows) == 1
    assert json.loads(rows[0].attributes_json) == {
        "platform.wrapper.environment": "prod",
        "platform.wrapper.project": "support",
    }
    assert json.loads(rows[0].payload_json) == {"id": "r1"}


def test_trace_record_with_list_field_remains_one_opaque_record() -> None:
    """A list-valued wrapper name cannot replace an already identifiable record."""
    content = json.dumps(
        {
            "trace_id": "parent-trace",
            "name": "agent run",
            "events": [{"trace_id": "nested-trace"}],
            "spans": [{"trace_id": "nested-span"}],
        },
        separators=(",", ":"),
    ).encode()

    rows = _normalize(content)

    assert len(rows) == 1
    assert rows[0].trace_id == "parent-trace"
    assert json.loads(rows[0].payload_json) == json.loads(content)


def test_ambiguous_list_fields_are_not_inferred_as_wrappers() -> None:
    """Generic data, event, and result arrays remain lossless opaque payloads."""
    content = b'{"source":"vendor","data":[{"id":"d1"}],"results":[{"id":"r1"}]}'

    rows = _normalize(content)

    assert len(rows) == 1
    assert json.loads(rows[0].payload_json) == json.loads(content)


def test_structured_wrapper_siblings_prevent_lossy_unwrapping() -> None:
    """Nested envelope metadata keeps the complete wrapper as one payload."""
    content = b'{"project":"support","metadata":{"owner":"ops"},"runs":[{"id":"r1"}]}'

    rows = _normalize(content)

    assert len(rows) == 1
    assert json.loads(rows[0].payload_json) == json.loads(content)


def test_digest_mismatch_fails_before_any_projection_row_is_built() -> None:
    """A corrupted Storage object cannot be acknowledged under another receipt."""
    with pytest.raises(TraceNormalizationError, match="digest"):
        normalize_trace_object(
            b'{"trace_id":"a"}',
            object_sha256="0" * 64,
            **_BASE,
        )
