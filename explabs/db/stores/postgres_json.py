# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Normalize untrusted JSON text before PostgreSQL persistence."""

from __future__ import annotations

from explabs.db.repositories import JsonObject, JsonPayload

_POSTGRES_REPLACEMENT_CHARACTER = "\N{REPLACEMENT CHARACTER}"


def normalize_postgres_json_string(value: str) -> str:
    """Normalize code points that PostgreSQL ``jsonb`` cannot translate."""
    normalized: list[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        code_point = ord(char)
        if code_point == 0:
            normalized.append(_POSTGRES_REPLACEMENT_CHARACTER)
        elif 0xD800 <= code_point <= 0xDBFF:
            if index + 1 < len(value):
                low = ord(value[index + 1])
                if 0xDC00 <= low <= 0xDFFF:
                    scalar = 0x10000 + ((code_point - 0xD800) << 10) + (low - 0xDC00)
                    normalized.append(chr(scalar))
                    index += 1
                else:
                    normalized.append(_POSTGRES_REPLACEMENT_CHARACTER)
            else:
                normalized.append(_POSTGRES_REPLACEMENT_CHARACTER)
        elif 0xDC00 <= code_point <= 0xDFFF:
            normalized.append(_POSTGRES_REPLACEMENT_CHARACTER)
        else:
            normalized.append(char)
        index += 1
    return "".join(normalized)


def _normalize_postgres_json_value(value: object) -> object:
    """Return a JSON value that PostgreSQL ``jsonb`` can represent.

    PostgreSQL rejects JSON escapes for embedded NULs and unpaired UTF-16
    surrogates with SQLSTATE ``22P05``. Model/tool output is untrusted text,
    so normalize those code points in both object keys and values before
    handing payloads to PostgREST. A valid surrogate pair is folded into its
    equivalent Unicode scalar. The replacement is applied only to the durable
    copy; live agent interactions retain the original value.
    """
    if isinstance(value, str):
        return normalize_postgres_json_string(value)
    if isinstance(value, dict):
        normalized: JsonObject = {}
        for key, item in value.items():
            normalized[str(_normalize_postgres_json_value(key))] = _normalize_postgres_json_value(
                item
            )
        return normalized
    if isinstance(value, list | tuple):
        return [_normalize_postgres_json_value(item) for item in value]
    return value


def normalize_postgres_json_object(value: JsonPayload) -> JsonObject:
    """Return a detached JSON object safe for PostgreSQL ``jsonb`` storage."""
    normalized: JsonObject = {}
    for key, item in value.items():
        normalized[str(_normalize_postgres_json_value(key))] = _normalize_postgres_json_value(item)
    return normalized
