# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Declared upload formats and transport-neutral byte validation.

Platform validates that an upload is bounded JSON or JSONL and stores its
bytes unchanged. It deliberately does not interpret vendor semantics; WMO's
canonical source loader owns that boundary.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from enum import StrEnum

from pydantic import JsonValue

MAX_TRACE_OBJECT_BYTES = 50 * 1024 * 1024
MAX_REMOTE_RECORDS = 1_000
MAX_SOURCE_LABEL_LENGTH = 200


class TraceUploadFormat(StrEnum):
    """The exact nine WMO file-source formats accepted by Platform."""

    BRAINTRUST = "braintrust"
    CHAT_JSON = "chat-json"
    LANGFUSE = "langfuse"
    LANGSMITH = "langsmith"
    MASTRA = "mastra"
    OTEL_GENAI = "otel-genai"
    OTLP = "otlp"
    PHOENIX = "phoenix"
    POSTHOG = "posthog"


TRACE_UPLOAD_FORMATS: tuple[TraceUploadFormat, ...] = tuple(TraceUploadFormat)

_ALLOWED_CONTENT_TYPES = frozenset(
    {
        "application/json",
        "application/jsonl",
        "application/octet-stream",
        "application/x-jsonlines",
        "application/x-ndjson",
        "text/json",
        "text/plain",
    }
)
_WRAPPER_KEYS = ("data", "events", "results", "runs", "spans", "traces", "resourceSpans")
_WINDOWS_ABSOLUTE = re.compile(r"^[A-Za-z]:[\\/]")


class TraceUploadValidationError(ValueError):
    """Raised when upload bytes or customer metadata are not safe to persist."""


@dataclass(frozen=True)
class ValidatedTraceUpload:
    """Validated immutable upload metadata without interpreting trace semantics."""

    content_type: str
    record_count_estimate: int


def validate_source_label(value: str) -> str:
    """Return a normalized durable label that cannot be a local path.

    Args:
        value: Customer-facing label supplied before acquisition.

    Returns:
        Whitespace-trimmed label.

    Raises:
        TraceUploadValidationError: If the label is blank, too long, path-like,
            or contains control characters.
    """
    normalized = value.strip()
    if not normalized:
        msg = "source_label must not be blank"
        raise TraceUploadValidationError(msg)
    if len(normalized) > MAX_SOURCE_LABEL_LENGTH:
        raise TraceUploadValidationError(
            f"source_label exceeds {MAX_SOURCE_LABEL_LENGTH} characters"
        )
    if any(unicodedata.category(character).startswith("C") for character in normalized):
        msg = "source_label must not contain control characters"
        raise TraceUploadValidationError(msg)
    if normalized.startswith(("/", "~/")) or _WINDOWS_ABSOLUTE.match(normalized):
        msg = "source_label must not be an absolute path"
        raise TraceUploadValidationError(msg)
    if "/" in normalized or "\\" in normalized:
        msg = "source_label must be a label, not a path"
        raise TraceUploadValidationError(msg)
    return normalized


def validate_trace_upload(
    content: bytes,
    *,
    content_type: str | None,
) -> ValidatedTraceUpload:
    """Validate bounded JSON/JSONL bytes without normalizing their schema.

    Args:
        content: Exact upload bytes that will be stored.
        content_type: Multipart content type, possibly with parameters.

    Returns:
        Normalized content type and a conservative record-count estimate.

    Raises:
        TraceUploadValidationError: If the body is empty, oversized, binary,
            uses an unsupported media type, or is not JSON/JSONL.
    """
    if not content:
        msg = "trace upload must not be empty"
        raise TraceUploadValidationError(msg)
    if len(content) > MAX_TRACE_OBJECT_BYTES:
        raise TraceUploadValidationError(
            f"trace upload exceeds the {MAX_TRACE_OBJECT_BYTES} byte object limit"
        )
    normalized_type = (content_type or "application/octet-stream").split(";", 1)[0].strip().lower()
    if normalized_type not in _ALLOWED_CONTENT_TYPES:
        raise TraceUploadValidationError(
            f"unsupported trace upload content type: {normalized_type or 'missing'}"
        )
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        msg = "trace upload must be UTF-8 JSON or JSONL"
        raise TraceUploadValidationError(msg) from error
    if "\x00" in text:
        msg = "trace upload must not contain binary NUL bytes"
        raise TraceUploadValidationError(msg)
    documents = _decode_documents(text)
    return ValidatedTraceUpload(
        content_type=normalized_type,
        record_count_estimate=_record_count(documents),
    )


def canonical_jsonl(records: list[JsonValue]) -> bytes:
    """Serialize remote records deterministically for hashing and dedupe.

    Args:
        records: Vendor or Postgres records already decoded as JSON values.

    Returns:
        UTF-8 JSONL with stable key ordering and one trailing newline.

    Raises:
        TraceUploadValidationError: If no records were acquired or the result
            exceeds the object-size limit.
    """
    if not records:
        msg = "remote source returned no trace records"
        raise TraceUploadValidationError(msg)
    try:
        lines = [
            json.dumps(
                record,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            )
            for record in records
        ]
    except (RecursionError, ValueError) as error:
        msg = "remote source returned non-finite JSON numbers"
        raise TraceUploadValidationError(msg) from error
    content = ("\n".join(lines) + "\n").encode()
    if len(content) > MAX_TRACE_OBJECT_BYTES:
        raise TraceUploadValidationError(
            f"acquired trace bytes exceed the {MAX_TRACE_OBJECT_BYTES} byte object limit"
        )
    return content


def _decode_documents(text: str) -> list[JsonValue]:
    """Decode one JSON document or a complete JSONL body."""
    try:
        document: JsonValue = json.loads(text, parse_constant=_reject_json_constant)
    except (RecursionError, ValueError):
        documents: list[JsonValue] = []
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                decoded: JsonValue = json.loads(line, parse_constant=_reject_json_constant)
            except (RecursionError, ValueError) as error:
                raise TraceUploadValidationError(
                    f"trace upload contains invalid JSON on line {line_number}"
                ) from error
            _require_container(decoded)
            documents.append(decoded)
        if not documents:
            msg = "trace upload contains no JSON records"
            raise TraceUploadValidationError(msg) from None
        return documents
    _require_container(document)
    return [document]


def _require_container(value: JsonValue) -> None:
    """Reject scalar JSON, which cannot encode a trace export."""
    if not isinstance(value, (dict, list)):
        msg = "trace upload JSON must be an object or array"
        raise TraceUploadValidationError(msg)


def _record_count(documents: list[JsonValue]) -> int:
    """Estimate top-level records without claiming canonical trace counts."""
    if len(documents) > 1:
        return len(documents)
    document = documents[0]
    if isinstance(document, list):
        return len(document)
    if isinstance(document, dict):
        for key in _WRAPPER_KEYS:
            wrapped = document.get(key)
            if isinstance(wrapped, list):
                return len(wrapped)
    return 1


def _reject_json_constant(value: str) -> JsonValue:
    """Reject Python's non-standard NaN and infinity JSON extensions."""
    msg = f"non-finite JSON number is not supported: {value}"
    raise ValueError(msg)
