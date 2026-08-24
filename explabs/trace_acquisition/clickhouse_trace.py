# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""ClickHouse transport for normalized, replayable trace projections."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from functools import cache
from urllib.parse import urlparse

import httpx
from pydantic import TypeAdapter

from explabs.db.repositories import JsonObject
from explabs.trace_acquisition.trace_normalization import NormalizedTraceRow

TRACE_TABLE = "explabs.trace_spans"
DEFAULT_BATCH_BYTES = 8 * 1024 * 1024
MAX_REQUEST_BYTES = 64 * 1024 * 1024
_DEFAULT_TIMEOUT_SECONDS = 45.0
_JSON_OBJECT_ADAPTER = TypeAdapter(dict[str, object])
_INSERT_LOG_COMMENT = "platform.trace_projection.insert"
_VERIFY_LOG_COMMENT = "platform.trace_projection.verify"
_READ_LOG_COMMENT = "platform.trace_projection.read"
_DELETE_LOG_COMMENT = "platform.trace_projection.delete"


class ClickHouseTraceError(RuntimeError):
    """A sanitized ClickHouse trace write or query failure."""


@dataclass(frozen=True)
class ClickHouseTraceSettings:
    """Server-only, region-pinned ClickHouse trace settings."""

    url: str
    username: str
    password: str = field(repr=False)
    expected_region: str
    projection_enabled: bool = False
    read_enabled: bool = False
    batch_bytes: int = DEFAULT_BATCH_BYTES

    @classmethod
    def from_env(
        cls,
        environment: Mapping[str, str] | None = None,
    ) -> ClickHouseTraceSettings | None:
        """Load the enabled all-or-none runtime tuple.

        Args:
            environment: Environment mapping; defaults to the process environment.

        Returns:
            Settings when trace projection is enabled, otherwise None.

        Raises:
            ValueError: If an enabled configuration is incomplete, invalid, or
                points outside the reviewed region.
        """
        values = os.environ if environment is None else environment
        projection_enabled = _env_bool(values, "CLICKHOUSE_TRACE_PROJECTION_ENABLED")
        read_enabled = _env_bool(values, "CLICKHOUSE_TRACE_READ_ENABLED")
        if not projection_enabled and not read_enabled:
            return None
        required = {
            "url": values.get("CLICKHOUSE_HTTP_URL", "").strip(),
            "username": values.get("CLICKHOUSE_HTTP_USERNAME", "").strip(),
            "password": values.get("CLICKHOUSE_HTTP_PASSWORD", ""),
            "expected_region": values.get("CLICKHOUSE_EXPECTED_REGION", "").strip().lower(),
        }
        missing = sorted(name for name, value in required.items() if not value)
        if missing:
            msg = f"Incomplete ClickHouse trace configuration; missing: {', '.join(missing)}"
            raise ValueError(msg)
        parsed = urlparse(required["url"])
        if parsed.scheme != "https" or parsed.hostname is None:
            msg = "CLICKHOUSE_HTTP_URL must be an HTTPS URL"
            raise ValueError(msg)
        hostname_tokens = parsed.hostname.lower().split(".")
        if required["expected_region"] not in hostname_tokens:
            msg = "ClickHouse endpoint does not match the expected region"
            raise ValueError(msg)
        try:
            batch_bytes = int(values.get("CLICKHOUSE_TRACE_BATCH_BYTES", str(DEFAULT_BATCH_BYTES)))
        except ValueError as error:
            msg = "CLICKHOUSE_TRACE_BATCH_BYTES must be an integer"
            raise ValueError(msg) from error
        if batch_bytes < 64 * 1024 or batch_bytes > MAX_REQUEST_BYTES:
            msg = "CLICKHOUSE_TRACE_BATCH_BYTES is outside the supported range"
            raise ValueError(msg)
        return cls(
            url=required["url"].rstrip("/"),
            username=required["username"],
            password=required["password"],
            expected_region=required["expected_region"],
            projection_enabled=projection_enabled,
            read_enabled=read_enabled,
            batch_bytes=batch_bytes,
        )


@cache
def _shared_http_client(settings: ClickHouseTraceSettings) -> httpx.Client:
    """Return one connection-pooled HTTP/2 client per process settings tuple."""
    return httpx.Client(
        base_url=f"{settings.url}/",
        auth=(settings.username, settings.password),
        timeout=httpx.Timeout(_DEFAULT_TIMEOUT_SECONDS, connect=5.0),
        http2=True,
    )


class ClickHouseTraceStore:
    """Write, verify, query, and erase the normalized trace read model."""

    def __init__(
        self,
        settings: ClickHouseTraceSettings,
        *,
        http_client: httpx.Client | None = None,
    ) -> None:
        """Initialize the store with a reusable HTTP client."""
        self._settings = settings
        self._http = http_client or _shared_http_client(settings)

    def insert(self, rows: Sequence[NormalizedTraceRow]) -> None:
        """Insert normalized rows in bounded, idempotently tokened batches.

        Args:
            rows: Deterministic rows from one immutable object.

        Raises:
            ClickHouseTraceError: If a row exceeds the hard request bound or
                ClickHouse does not acknowledge a batch.
        """
        if not rows:
            return
        first = rows[0]
        for batch_index, batch in enumerate(_batches(rows, self._settings.batch_bytes)):
            content = "\n".join(row.json_each_row() for row in batch) + "\n"
            token = (
                f"trace:{first.ingest_id}:v{first.projection_version}:"
                f"a{first.projection_attempt}:b{batch_index}"
            )
            self._post(
                query=f"INSERT INTO {TRACE_TABLE} FORMAT JSONEachRow",
                content=content,
                log_comment=_INSERT_LOG_COMMENT,
                extra_params={
                    "insert_deduplication_token": token,
                },
            )

    def count_ingest(
        self,
        *,
        org_id: str,
        ingest_id: str,
        projection_version: int,
    ) -> int:
        """Read back the exact projected row count before queue acknowledgement."""
        query = f"""
SELECT count()
FROM {TRACE_TABLE} FINAL
WHERE org_id = {{org_id:UUID}}
  AND ingest_id = {{ingest_id:UUID}}
  AND projection_version = {{projection_version:UInt16}}
FORMAT JSONEachRow
""".strip()
        rows = self._query(
            query,
            {
                "org_id": org_id,
                "ingest_id": ingest_id,
                "projection_version": str(projection_version),
            },
            log_comment=_VERIFY_LOG_COMMENT,
        )
        if len(rows) != 1:
            msg = "ClickHouse trace verification returned an invalid row count"
            raise ClickHouseTraceError(msg)
        value = rows[0].get("count()")
        if isinstance(value, int) and value >= 0:
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
        msg = "ClickHouse trace verification returned an invalid count"
        raise ClickHouseTraceError(msg)

    def list_ingest(
        self,
        *,
        org_id: str,
        ingest_id: str,
        projection_version: int,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[JsonObject, ...]:
        """List normalized records for one tenant-owned ingest."""
        cap = min(max(limit, 1), 500)
        skip = max(offset, 0)
        query = f"""
SELECT
  record_index,
  event_type,
  trace_id,
  span_id,
  parent_span_id,
  name,
  span_kind,
  status,
  started_at_ns,
  duration_ns,
  model,
  input_tokens,
  output_tokens,
  attributes_json
FROM {TRACE_TABLE} FINAL
WHERE org_id = {{org_id:UUID}}
  AND ingest_id = {{ingest_id:UUID}}
  AND projection_version = {{projection_version:UInt16}}
ORDER BY record_index
LIMIT {{limit:UInt32}} OFFSET {{offset:UInt64}}
FORMAT JSONEachRow
""".strip()
        return self._query(
            query,
            {
                "org_id": org_id,
                "ingest_id": ingest_id,
                "projection_version": str(projection_version),
                "limit": str(cap),
                "offset": str(skip),
            },
            log_comment=_READ_LOG_COMMENT,
        )

    def delete_ingest(self, *, org_id: str, ingest_id: str) -> None:
        """Synchronously apply one tenant-scoped ClickHouse deletion."""
        query = f"""
DELETE FROM {TRACE_TABLE}
WHERE org_id = {{org_id:UUID}} AND ingest_id = {{ingest_id:UUID}}
""".strip()
        self._post(
            query=query,
            content="",
            log_comment=_DELETE_LOG_COMMENT,
            extra_params={"mutations_sync": "1"},
            typed_params={"org_id": org_id, "ingest_id": ingest_id},
        )

    def _query(
        self,
        query: str,
        params: Mapping[str, str],
        *,
        log_comment: str,
    ) -> tuple[JsonObject, ...]:
        """Execute a typed query and validate JSONEachRow response objects."""
        try:
            response = self._http.post(
                "",
                params={
                    "log_comment": log_comment,
                    **{f"param_{name}": value for name, value in params.items()},
                },
                content=query,
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            msg = "ClickHouse trace query failed"
            raise ClickHouseTraceError(msg) from error
        rows: list[JsonObject] = []
        try:
            for line in response.text.splitlines():
                if not line:
                    continue
                decoded: object = json.loads(line)
                rows.append(_JSON_OBJECT_ADAPTER.validate_python(decoded))
        except (json.JSONDecodeError, ValueError) as error:
            msg = "ClickHouse trace query returned invalid JSON"
            raise ClickHouseTraceError(msg) from error
        return tuple(rows)

    def _post(
        self,
        *,
        query: str,
        content: str,
        log_comment: str,
        extra_params: Mapping[str, str] | None = None,
        typed_params: Mapping[str, str] | None = None,
    ) -> None:
        """Execute one statement without exposing endpoint credentials."""
        params = {"query": query, "log_comment": log_comment, **dict(extra_params or {})}
        params.update({f"param_{key}": value for key, value in (typed_params or {}).items()})
        try:
            response = self._http.post("", params=params, content=content)
            response.raise_for_status()
        except httpx.HTTPError as error:
            msg = "ClickHouse trace write failed"
            raise ClickHouseTraceError(msg) from error


def _batches(
    rows: Sequence[NormalizedTraceRow],
    target_bytes: int,
) -> tuple[tuple[NormalizedTraceRow, ...], ...]:
    """Bound every request body by the configured operator limit."""
    batches: list[tuple[NormalizedTraceRow, ...]] = []
    current: list[NormalizedTraceRow] = []
    current_bytes = 0
    for row in rows:
        row_bytes = len(row.json_each_row().encode()) + 1
        if row_bytes > target_bytes:
            msg = "normalized trace row exceeds the configured ClickHouse batch limit"
            raise ClickHouseTraceError(msg)
        if current and current_bytes + row_bytes > target_bytes:
            batches.append(tuple(current))
            current = []
            current_bytes = 0
        current.append(row)
        current_bytes += row_bytes
    if current:
        batches.append(tuple(current))
    return tuple(batches)


def _env_bool(values: Mapping[str, str], name: str) -> bool:
    """Read one strict opt-in boolean from an environment mapping."""
    return values.get(name, "").strip().lower() in {"1", "true"}
