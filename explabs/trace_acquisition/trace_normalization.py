# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Normalize immutable trace exports into a queryable ClickHouse row shape.

The raw object in Storage is authoritative. This module extracts stable fields
used by tenant/time/trace queries while retaining each source record as JSON in
ClickHouse. Vendor-specific fields that Platform does not yet understand remain
available in ``payload_json`` and can be re-projected with a later version.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Mapping, Sequence
from datetime import UTC, datetime

from pydantic import BaseModel, ConfigDict, JsonValue

from explabs.db.repositories import JsonObject

# Only container names whose meaning is intrinsically trace-shaped are inferred.
# Ambiguous fields such as ``data``, ``events``, and ``results`` remain opaque
# unless a source-specific adapter is added later.
_GENERIC_WRAPPER_KEYS = ("runs", "spans", "traces")
_OTLP_SCOPE_KEYS = ("scopeSpans", "instrumentationLibrarySpans")
_TRACE_ID_KEYS = ("trace_id", "traceId", "traceID")
_SPAN_ID_KEYS = ("span_id", "spanId", "spanID", "id")
_PARENT_ID_KEYS = ("parent_span_id", "parentSpanId", "parentSpanID", "parent_id")
_NAME_KEYS = ("name", "operation_name", "operationName", "span_name", "event")
_START_NS_KEYS = ("startTimeUnixNano", "start_time_unix_nano", "start_time_ns")
_END_NS_KEYS = ("endTimeUnixNano", "end_time_unix_nano", "end_time_ns")
_DURATION_NS_KEYS = ("duration_ns", "durationNanos", "durationNano")
_MODEL_ATTRIBUTE_KEYS = (
    "gen_ai.request.model",
    "gen_ai.response.model",
    "llm.model_name",
    "model",
)
_INPUT_TOKEN_KEYS = (
    "gen_ai.usage.input_tokens",
    "llm.token_count.prompt",
    "input_tokens",
    "prompt_tokens",
)
_OUTPUT_TOKEN_KEYS = (
    "gen_ai.usage.output_tokens",
    "llm.token_count.completion",
    "output_tokens",
    "completion_tokens",
)


class TraceNormalizationError(ValueError):
    """Stored trace bytes cannot be normalized without losing row identity."""


class NormalizedTraceRow(BaseModel):
    """One source record projected into the ClickHouse trace schema."""

    model_config = ConfigDict(frozen=True)

    org_id: str
    ingest_id: str
    projection_version: int
    projection_attempt: int
    record_index: int
    event_id: str
    source_kind: str
    transport_kind: str
    source_label: str
    event_type: str
    trace_id: str
    span_id: str
    parent_span_id: str | None
    name: str
    span_kind: str
    status: str
    started_at_ns: int | None
    duration_ns: int | None
    model: str | None
    input_tokens: int
    output_tokens: int
    attributes_json: str
    payload_json: str
    payload_sha256: str
    object_sha256: str
    received_at: str

    def json_each_row(self) -> str:
        """Serialize one compact ClickHouse JSONEachRow line."""
        return json.dumps(self.model_dump(mode="json"), separators=(",", ":"), ensure_ascii=False)


def normalize_trace_object(
    content: bytes,
    *,
    org_id: str,
    ingest_id: str,
    source_kind: str,
    transport_kind: str,
    source_label: str,
    object_sha256: str,
    received_at: str,
    projection_version: int,
    projection_attempt: int,
) -> tuple[NormalizedTraceRow, ...]:
    """Decode and normalize every record in one immutable trace object.

    Args:
        content: Previously validated JSON or JSONL bytes from Storage.
        org_id: Owning organization identifier.
        ingest_id: Durable ingest receipt identifier.
        source_kind: Declared vendor/export format.
        transport_kind: Collection transport.
        source_label: Customer-facing source label.
        object_sha256: Expected digest of the exact raw bytes.
        received_at: Stable receipt timestamp used for partitioning.
        projection_version: Normalization contract version.
        projection_attempt: Monotonic queue attempt for replacement semantics.

    Returns:
        Queryable rows in deterministic record order.

    Raises:
        TraceNormalizationError: If bytes, digest, or record shapes are invalid.
    """
    actual_digest = hashlib.sha256(content, usedforsecurity=False).hexdigest()
    if actual_digest != object_sha256:
        msg = "stored trace object digest does not match its receipt"
        raise TraceNormalizationError(msg)
    rows: list[NormalizedTraceRow] = []
    for index, extracted in enumerate(_iter_extracted_records(_decode_documents(content))):
        record, inherited = extracted
        payload_json = _canonical_json(record)
        payload_sha256 = hashlib.sha256(payload_json.encode(), usedforsecurity=False).hexdigest()
        attributes = _attributes(record)
        attributes.update(inherited)
        trace_id = _text(record, _TRACE_ID_KEYS) or _text(attributes, _TRACE_ID_KEYS) or ""
        span_id = _text(record, _SPAN_ID_KEYS) or _text(attributes, _SPAN_ID_KEYS) or ""
        started_at_ns = _timestamp_ns(record)
        duration_ns = _duration_ns(record, started_at_ns)
        event_type = "span" if trace_id or span_id or started_at_ns is not None else "record"
        event_id = hashlib.sha256(
            f"{object_sha256}:{index}:{payload_sha256}".encode(), usedforsecurity=False
        ).hexdigest()
        rows.append(
            NormalizedTraceRow(
                org_id=org_id,
                ingest_id=ingest_id,
                projection_version=projection_version,
                projection_attempt=projection_attempt,
                record_index=index,
                event_id=event_id,
                source_kind=source_kind,
                transport_kind=transport_kind,
                source_label=source_label,
                event_type=event_type,
                trace_id=trace_id,
                span_id=span_id,
                parent_span_id=_text(record, _PARENT_ID_KEYS),
                name=_text(record, _NAME_KEYS) or "",
                span_kind=_span_kind(record),
                status=_status(record, attributes),
                started_at_ns=started_at_ns,
                duration_ns=duration_ns,
                model=_first_text(attributes, _MODEL_ATTRIBUTE_KEYS)
                or _text(record, ("model", "model_name")),
                input_tokens=_first_nonnegative_int(attributes, _INPUT_TOKEN_KEYS),
                output_tokens=_first_nonnegative_int(attributes, _OUTPUT_TOKEN_KEYS),
                attributes_json=_canonical_json(attributes),
                payload_json=payload_json,
                payload_sha256=payload_sha256,
                object_sha256=object_sha256,
                received_at=_clickhouse_datetime(received_at),
            )
        )
    if not rows:
        msg = "stored trace object contains no records"
        raise TraceNormalizationError(msg)
    return tuple(rows)


def _decode_documents(content: bytes) -> tuple[JsonValue, ...]:
    """Decode one JSON document or a complete JSONL object."""
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        msg = "stored trace object is not UTF-8"
        raise TraceNormalizationError(msg) from error
    try:
        decoded: JsonValue = json.loads(text)
    except (RecursionError, ValueError):
        documents: list[JsonValue] = []
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                documents.append(json.loads(line))
            except (RecursionError, ValueError) as error:
                msg = "stored trace object is not valid JSON or JSONL"
                raise TraceNormalizationError(msg) from error
        return tuple(documents)
    return (decoded,)


def _iter_extracted_records(
    documents: Sequence[JsonValue],
) -> Iterator[tuple[JsonObject, JsonObject]]:
    """Yield flattened records with inherited wrapper/resource context."""
    for document in documents:
        if isinstance(document, list):
            for record in document:
                yield _object_record(record), {}
            continue
        record = _object_record(document)
        resource_spans = record.get("resourceSpans")
        if isinstance(resource_spans, list):
            for resource_span in resource_spans:
                yield from _iter_otlp_resource_span(_object_record(resource_span))
            continue
        wrapper_keys = [key for key in _GENERIC_WRAPPER_KEYS if isinstance(record.get(key), list)]
        if len(wrapper_keys) != 1 or _looks_like_trace_record(record):
            yield record, {}
            continue
        wrapper_key = wrapper_keys[0]
        wrapper_siblings = {key: value for key, value in record.items() if key != wrapper_key}
        wrapped = record[wrapper_key]
        if (
            not all(_is_scalar(value) for value in wrapper_siblings.values())
            or not isinstance(wrapped, list)
            or not wrapped
            or not all(
                isinstance(child, Mapping) and _looks_like_trace_record(_object_record(child))
                for child in wrapped
            )
        ):
            yield record, {}
            continue
        wrapper_context = {
            f"platform.wrapper.{key}": value for key, value in wrapper_siblings.items()
        }
        for child in wrapped:
            yield _object_record(child), wrapper_context


def _looks_like_trace_record(record: Mapping[str, object]) -> bool:
    """Return whether an object has fields that identify it as one trace record."""
    record_keys = set(record)
    return bool(
        record_keys.intersection(
            {
                *_TRACE_ID_KEYS,
                *_SPAN_ID_KEYS,
                *_PARENT_ID_KEYS,
                *_NAME_KEYS,
                *_START_NS_KEYS,
                *_END_NS_KEYS,
                *_DURATION_NS_KEYS,
                "attributes",
                "status",
                "timestamp",
                "timestamp_ns",
            }
        )
    )


def _iter_otlp_resource_span(resource_span: JsonObject) -> Iterator[tuple[JsonObject, JsonObject]]:
    """Flatten one OTLP resource envelope while retaining inherited context."""
    inherited: JsonObject = {}
    resource = resource_span.get("resource")
    if isinstance(resource, Mapping):
        inherited.update(
            {
                f"resource.{key}": value
                for key, value in _otel_attributes(_object_record(resource)).items()
            }
        )
    for scope_key in _OTLP_SCOPE_KEYS:
        raw_scopes = resource_span.get(scope_key)
        if not isinstance(raw_scopes, list):
            continue
        for raw_scope in raw_scopes:
            scope = _object_record(raw_scope)
            scope_context = dict(inherited)
            raw_scope_identity = scope.get("scope") or scope.get("instrumentationLibrary")
            if isinstance(raw_scope_identity, Mapping):
                for key, value in raw_scope_identity.items():
                    if _is_scalar(value):
                        scope_context[f"scope.{key}"] = value
            spans = scope.get("spans")
            if not isinstance(spans, list):
                continue
            for span in spans:
                yield _object_record(span), scope_context


def _object_record(value: object) -> JsonObject:
    """Return a JSON object, wrapping arrays/scalars without losing payload."""
    if isinstance(value, Mapping):
        return {str(key): item for key, item in value.items()}
    return {"value": value}


def _attributes(record: Mapping[str, object]) -> JsonObject:
    """Extract a flat attribute map from common vendor and OTLP shapes."""
    attributes = record.get("attributes")
    if isinstance(attributes, Mapping):
        return {str(key): _otel_value(value) for key, value in attributes.items()}
    if isinstance(attributes, list):
        flattened: JsonObject = {}
        for item in attributes:
            if not isinstance(item, Mapping):
                continue
            item_object = _object_record(item)
            key = item_object.get("key")
            if isinstance(key, str):
                flattened[key] = _otel_value(item_object.get("value"))
        return flattened
    return {}


def _otel_attributes(container: Mapping[str, object]) -> JsonObject:
    """Extract attributes from an OTLP resource or span container."""
    return _attributes(container)


def _otel_value(value: object) -> object:
    """Unwrap the OTLP AnyValue JSON encoding recursively."""
    if not isinstance(value, Mapping):
        return value
    mapped = _object_record(value)
    for key in (
        "stringValue",
        "boolValue",
        "intValue",
        "doubleValue",
        "bytesValue",
    ):
        if key in mapped:
            return mapped[key]
    array_value = mapped.get("arrayValue")
    if isinstance(array_value, Mapping):
        return _otel_array(array_value)
    key_value_list = mapped.get("kvlistValue")
    if isinstance(key_value_list, Mapping):
        return _otel_key_value_list(key_value_list)
    return {str(key): _otel_value(item) for key, item in mapped.items()}


def _otel_array(value: object) -> list[object]:
    """Unwrap an OTLP array AnyValue."""
    items = _object_record(value).get("values")
    return [_otel_value(item) for item in items] if isinstance(items, list) else []


def _otel_key_value_list(value: object) -> JsonObject:
    """Unwrap an OTLP key-value-list AnyValue."""
    items = _object_record(value).get("values")
    if not isinstance(items, list):
        return {}
    flattened: JsonObject = {}
    for item in items:
        if not isinstance(item, Mapping):
            continue
        item_object = _object_record(item)
        key = item_object.get("key")
        if isinstance(key, str):
            flattened[key] = _otel_value(item_object.get("value"))
    return flattened


def _timestamp_ns(record: Mapping[str, object]) -> int | None:
    """Extract a nonnegative start timestamp in Unix nanoseconds."""
    direct = _first_nonnegative_optional_int(record, _START_NS_KEYS)
    if direct is not None:
        return direct
    for key in ("start_time", "startTime", "started_at", "timestamp"):
        value = record.get(key)
        if isinstance(value, str):
            try:
                moment = datetime.fromisoformat(value)
            except ValueError:
                continue
            return int(moment.timestamp() * 1_000_000_000)
    return None


def _duration_ns(record: Mapping[str, object], started_at_ns: int | None) -> int | None:
    """Extract or derive a nonnegative span duration in nanoseconds."""
    direct = _first_nonnegative_optional_int(record, _DURATION_NS_KEYS)
    if direct is not None:
        return direct
    ended_at_ns = _first_nonnegative_optional_int(record, _END_NS_KEYS)
    if started_at_ns is not None and ended_at_ns is not None and ended_at_ns >= started_at_ns:
        return ended_at_ns - started_at_ns
    duration_ms = _first_nonnegative_optional_int(record, ("duration_ms", "latency_ms"))
    return None if duration_ms is None else duration_ms * 1_000_000


def _status(record: Mapping[str, object], attributes: Mapping[str, object]) -> str:
    """Normalize common status encodings to a bounded analytical label."""
    raw = record.get("status")
    if isinstance(raw, Mapping):
        status_object = _object_record(raw)
        raw = (
            status_object.get("code")
            or status_object.get("status_code")
            or status_object.get("message")
        )
    if isinstance(raw, str) and raw.strip():
        return raw.strip().lower()[:64]
    if isinstance(raw, (int, bool)):
        return str(raw).lower()
    for key in ("error", "error.type", "exception.type"):
        if attributes.get(key):
            return "error"
    return "unset"


def _span_kind(record: Mapping[str, object]) -> str:
    """Normalize a span kind or role without assuming one vendor enum."""
    raw = record.get("kind") or record.get("span_kind") or record.get("role")
    if isinstance(raw, str):
        return raw.strip().lower()[:64]
    if isinstance(raw, int):
        return str(raw)
    return "unspecified"


def _first_text(values: Mapping[str, object], keys: Sequence[str]) -> str | None:
    """Return the first non-empty string in a mapping."""
    for key in keys:
        value = values.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _text(values: Mapping[str, object], keys: Sequence[str]) -> str | None:
    """Return a scalar identifier as text without serializing containers."""
    for key in keys:
        value = values.get(key)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, int) and not isinstance(value, bool):
            return str(value)
    return None


def _first_nonnegative_int(values: Mapping[str, object], keys: Sequence[str]) -> int:
    """Return the first nonnegative integer, defaulting to zero."""
    return _first_nonnegative_optional_int(values, keys) or 0


def _first_nonnegative_optional_int(
    values: Mapping[str, object], keys: Sequence[str]
) -> int | None:
    """Return the first nonnegative integer-like value."""
    for key in keys:
        value = values.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int) and value >= 0:
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    return None


def _canonical_json(value: object) -> str:
    """Serialize JSON deterministically for identity and compressed storage."""
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (RecursionError, TypeError, ValueError) as error:
        msg = "trace record contains unsupported JSON"
        raise TraceNormalizationError(msg) from error


def _clickhouse_datetime(value: str) -> str:
    """Format an aware ISO receipt timestamp for ClickHouse DateTime64."""
    try:
        moment = datetime.fromisoformat(value)
    except ValueError as error:
        msg = "trace receipt timestamp is invalid"
        raise TraceNormalizationError(msg) from error
    if moment.tzinfo is None:
        msg = "trace receipt timestamp must include a timezone"
        raise TraceNormalizationError(msg)
    return moment.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")


def _is_scalar(value: object) -> bool:
    """Return whether a wrapper value is cheap, queryable context."""
    return value is None or isinstance(value, (str, int, float, bool))
