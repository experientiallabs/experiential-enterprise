# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Bounded Platform-owned transports for remote trace acquisition.

The transports return decoded vendor records. They never normalize records
into WMO traces and never own credentials; a credential is released from
Vault immediately before each acquisition attempt and passed transiently.
"""

from __future__ import annotations

import ipaddress
import json
import re
from collections.abc import Mapping
from datetime import datetime
from enum import StrEnum
from typing import Protocol, runtime_checkable
from urllib.parse import quote, urlsplit
from uuid import UUID

import httpx
import psycopg
from psycopg import sql
from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter

from explabs.db.repositories import JsonObject
from explabs.trace_acquisition.formats import (
    MAX_REMOTE_RECORDS,
    MAX_TRACE_OBJECT_BYTES,
    TraceUploadFormat,
)

HTTP_TIMEOUT_SECONDS = 60.0
HTTP_PAGE_SIZE = 100
_JSON_VALUE_ADAPTER = TypeAdapter(JsonValue)


class TraceTransportKind(StrEnum):
    """How Platform obtains raw bytes for one acquisition."""

    UPLOAD = "upload"
    LANGFUSE = "langfuse"
    LANGSMITH = "langsmith"
    BRAINTRUST = "braintrust"
    POSTHOG = "posthog"
    MASTRA = "mastra"
    POSTGRES = "postgres"


REMOTE_TRACE_TRANSPORTS: tuple[TraceTransportKind, ...] = tuple(
    kind for kind in TraceTransportKind if kind is not TraceTransportKind.UPLOAD
)


class AcquisitionErrorCode(StrEnum):
    """Stable customer-safe terminal acquisition error codes."""

    BAD_CREDENTIALS = "bad_credentials"
    CONNECTION_MISSING = "connection_missing"
    INVALID_SOURCE_CONFIG = "invalid_source_config"
    INVALID_SOURCE_RESPONSE = "invalid_source_response"
    OBJECT_TOO_LARGE = "object_too_large"
    RATE_LIMITED = "rate_limited"
    SOURCE_TIMEOUT = "source_timeout"
    SOURCE_UNAVAILABLE = "source_unavailable"
    STORAGE_FAILED = "storage_failed"


class ConnectorError(RuntimeError):
    """A remote failure reduced to a safe stable code.

    Raw provider bodies and exception strings are intentionally not retained
    on this exception because callers persist its code.
    """

    def __init__(self, code: AcquisitionErrorCode) -> None:
        """Initialize a sanitized connector failure."""
        super().__init__(code.value)
        self.code = code


class ConnectorRequest(BaseModel):
    """Typed, secret-free inputs shared by all remote transports."""

    model_config = ConfigDict(frozen=True)

    source_format: TraceUploadFormat
    config: JsonObject = Field(default_factory=dict)
    since: str | None = None


class ConnectorBatch(BaseModel):
    """One bounded page plus its connector-owned continuation cursor."""

    model_config = ConfigDict(frozen=True)

    records: tuple[JsonValue, ...]
    next_cursor: str | None = None


@runtime_checkable
class TraceConnector(Protocol):
    """Fetch one bounded page from one authenticated remote source."""

    kind: TraceTransportKind

    def fetch_page(
        self,
        request: ConnectorRequest,
        *,
        credential: str,
        cursor: str | None,
        limit: int,
    ) -> ConnectorBatch:
        """Return at most ``limit`` records and an optional next cursor."""
        ...


class ConnectorRegistry:
    """Explicit registry for exactly the six verified remote transports."""

    def __init__(self, connectors: Mapping[TraceTransportKind, TraceConnector]) -> None:
        """Initialize and validate the complete remote connector set."""
        expected = frozenset(REMOTE_TRACE_TRANSPORTS)
        actual = frozenset(connectors)
        if actual != expected:
            missing = sorted(kind.value for kind in expected - actual)
            extra = sorted(kind.value for kind in actual - expected)
            raise ValueError(
                f"remote connector registry mismatch: missing={missing}, extra={extra}"
            )
        self._connectors = dict(connectors)

    def get(self, kind: TraceTransportKind) -> TraceConnector:
        """Return a registered remote connector, rejecting upload/Phoenix fiction."""
        connector = self._connectors.get(kind)
        if connector is None:
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
        return connector


def connector_registry(client: httpx.Client) -> ConnectorRegistry:
    """Build the production registry around one bounded HTTP client."""
    connectors: dict[TraceTransportKind, TraceConnector] = {
        TraceTransportKind.LANGFUSE: LangfuseConnector(client),
        TraceTransportKind.LANGSMITH: LangSmithConnector(client),
        TraceTransportKind.BRAINTRUST: BraintrustConnector(client),
        TraceTransportKind.POSTHOG: PostHogConnector(client),
        TraceTransportKind.MASTRA: MastraConnector(client),
        TraceTransportKind.POSTGRES: PostgresConnector(),
    }
    return ConnectorRegistry(connectors)


class _HttpConnector:
    """Shared safe request and response handling for HTTP transports."""

    def __init__(self, client: httpx.Client) -> None:
        self._client = client

    def _json(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, str] | None = None,
        json_body: JsonObject | None = None,
        auth: httpx.Auth | None = None,
        timeout: float = HTTP_TIMEOUT_SECONDS,
    ) -> JsonValue:
        """Execute a request and return JSON while erasing vendor error text."""
        try:
            response = self._client.request(
                method,
                url,
                headers=headers,
                params=params,
                json=json_body,
                auth=auth,
                timeout=timeout,
            )
        except httpx.TimeoutException as error:
            raise ConnectorError(AcquisitionErrorCode.SOURCE_TIMEOUT) from error
        except httpx.HTTPError as error:
            raise ConnectorError(AcquisitionErrorCode.SOURCE_UNAVAILABLE) from error
        if response.status_code in (401, 403):
            raise ConnectorError(AcquisitionErrorCode.BAD_CREDENTIALS)
        if response.status_code == 429:
            raise ConnectorError(AcquisitionErrorCode.RATE_LIMITED)
        if response.status_code >= 400:
            raise ConnectorError(AcquisitionErrorCode.SOURCE_UNAVAILABLE)
        if len(response.content) > MAX_TRACE_OBJECT_BYTES:
            raise ConnectorError(AcquisitionErrorCode.OBJECT_TOO_LARGE)
        try:
            payload = _JSON_VALUE_ADAPTER.validate_python(
                response.json(parse_constant=_reject_json_constant)
            )
        except (RecursionError, UnicodeDecodeError, ValueError) as error:
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE) from error
        return payload


class LangfuseConnector(_HttpConnector):
    """Paginate Langfuse v1 trace ids and fetch each complete trace export."""

    kind = TraceTransportKind.LANGFUSE
    _default_host = "https://cloud.langfuse.com"
    _page_size = 50

    def fetch_page(
        self,
        request: ConnectorRequest,
        *,
        credential: str,
        cursor: str | None,
        limit: int,
    ) -> ConnectorBatch:
        """Fetch one offset page and its complete trace objects."""
        public_key, secret_key = _credential_pair(credential)
        host = _safe_https_base(_config_text(request.config, "host") or self._default_host)
        page = _positive_cursor(cursor, start=1)
        page_limit = min(limit, self._page_size)
        params: dict[str, str] = {"page": str(page), "limit": str(page_limit)}
        if request.since is not None:
            params["fromTimestamp"] = _iso_timestamp(request.since)
        listed = self._json(
            "GET",
            f"{host}/api/public/traces",
            auth=httpx.BasicAuth(public_key, secret_key),
            params=params,
            timeout=HTTP_TIMEOUT_SECONDS,
        )
        if not isinstance(listed, dict) or not isinstance(listed.get("data"), list):
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE)
        rows = listed["data"][:page_limit]
        records: list[JsonValue] = []
        canonical_byte_size = 0
        for row in rows:
            trace_id = row.get("id") if isinstance(row, dict) else None
            if not isinstance(trace_id, str) or not trace_id:
                raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE)
            record = self._json(
                "GET",
                f"{host}/api/public/traces/{quote(trace_id, safe='')}",
                auth=httpx.BasicAuth(public_key, secret_key),
                timeout=HTTP_TIMEOUT_SECONDS,
            )
            canonical_byte_size += _json_byte_size(record) + 1
            if canonical_byte_size > MAX_TRACE_OBJECT_BYTES:
                raise ConnectorError(AcquisitionErrorCode.OBJECT_TOO_LARGE)
            records.append(record)
        next_cursor = str(page + 1) if len(rows) == page_limit else None
        return ConnectorBatch(records=tuple(records), next_cursor=next_cursor)


class LangSmithConnector(_HttpConnector):
    """Paginate LangSmith runs using the API's opaque next cursor."""

    kind = TraceTransportKind.LANGSMITH
    _default_endpoint = "https://api.smith.langchain.com"

    def fetch_page(
        self,
        request: ConnectorRequest,
        *,
        credential: str,
        cursor: str | None,
        limit: int,
    ) -> ConnectorBatch:
        """Fetch one cursor page of run records."""
        endpoint = _safe_https_base(_config_text(request.config, "host") or self._default_endpoint)
        body: JsonObject = {"limit": min(limit, HTTP_PAGE_SIZE)}
        project = _config_text(request.config, "project")
        if project is not None:
            body["session"] = [project]
        if request.since is not None:
            body["start_time"] = _iso_timestamp(request.since)
        if cursor is not None:
            body["cursor"] = cursor
        payload = self._json(
            "POST",
            f"{endpoint}/api/v1/runs/query",
            headers={"x-api-key": credential},
            json_body=body,
            timeout=HTTP_TIMEOUT_SECONDS,
        )
        if not isinstance(payload, dict) or not isinstance(payload.get("runs"), list):
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE)
        records = tuple(payload["runs"][:limit])
        cursors = payload.get("cursors")
        next_cursor = cursors.get("next") if isinstance(cursors, dict) else None
        if next_cursor is not None and not isinstance(next_cursor, str):
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE)
        return ConnectorBatch(records=records, next_cursor=next_cursor or None)


class BraintrustConnector(_HttpConnector):
    """Paginate Braintrust project-log events with the returned opaque cursor."""

    kind = TraceTransportKind.BRAINTRUST
    _default_host = "https://api.braintrust.dev"

    def fetch_page(
        self,
        request: ConnectorRequest,
        *,
        credential: str,
        cursor: str | None,
        limit: int,
    ) -> ConnectorBatch:
        """Resolve the configured project and fetch one bounded logs page."""
        if request.since is not None:
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
        host = _safe_https_base(_config_text(request.config, "host") or self._default_host)
        project = _required_config_text(request.config, "project")
        headers = {"Authorization": f"Bearer {credential}"}
        project_id = self._project_id(host, project, headers)
        params: dict[str, str] = {"limit": str(min(limit, HTTP_PAGE_SIZE))}
        if cursor is not None:
            params["cursor"] = cursor
        payload = self._json(
            "GET",
            f"{host}/v1/project_logs/{quote(project_id, safe='')}/fetch",
            headers=headers,
            params=params,
            timeout=HTTP_TIMEOUT_SECONDS,
        )
        if not isinstance(payload, dict) or not isinstance(payload.get("events"), list):
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE)
        next_cursor = payload.get("cursor")
        if next_cursor is not None and not isinstance(next_cursor, str):
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE)
        return ConnectorBatch(
            records=tuple(payload["events"][:limit]),
            next_cursor=next_cursor or None,
        )

    def _project_id(self, host: str, project: str, headers: dict[str, str]) -> str:
        """Use a UUID directly or resolve an exact project name server-side."""
        try:
            UUID(project)
        except ValueError as error:
            payload = self._json(
                "GET",
                f"{host}/v1/project",
                headers=headers,
                params={"project_name": project, "limit": "100"},
                timeout=HTTP_TIMEOUT_SECONDS,
            )
            objects = payload.get("objects") if isinstance(payload, dict) else None
            if not isinstance(objects, list):
                raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE) from error
            for item in objects:
                if isinstance(item, dict) and item.get("name") == project:
                    project_id = item.get("id")
                    if isinstance(project_id, str):
                        try:
                            return str(UUID(project_id))
                        except ValueError:
                            raise ConnectorError(
                                AcquisitionErrorCode.INVALID_SOURCE_RESPONSE
                            ) from None
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG) from error
        return project


class PostHogConnector(_HttpConnector):
    """Run one bounded PostHog HogQL query for AI telemetry events."""

    kind = TraceTransportKind.POSTHOG
    _default_host = "https://us.posthog.com"

    def fetch_page(
        self,
        request: ConnectorRequest,
        *,
        credential: str,
        cursor: str | None,
        limit: int,
    ) -> ConnectorBatch:
        """Fetch up to the requested hard limit; HogQL needs no second page."""
        if cursor is not None:
            return ConnectorBatch(records=())
        host = _safe_https_base(_config_text(request.config, "host") or self._default_host)
        project = _positive_decimal(_required_config_text(request.config, "project"))
        query = "select event, properties, timestamp from events where event like '$ai_%'"
        if request.since is not None:
            timestamp = _iso_timestamp(request.since).replace("'", "''")
            query += f" and timestamp >= parseDateTimeBestEffort('{timestamp}')"
        query += f" order by timestamp asc limit {int(min(limit, MAX_REMOTE_RECORDS))}"
        payload = self._json(
            "POST",
            f"{host}/api/projects/{project}/query/",
            headers={"Authorization": f"Bearer {credential}"},
            json_body={"query": {"kind": "HogQLQuery", "query": query}},
            timeout=HTTP_TIMEOUT_SECONDS,
        )
        results = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(results, list):
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE)
        records: list[JsonValue] = []
        for row in results[:limit]:
            if not isinstance(row, list) or len(row) < 3:
                raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE)
            properties = row[1]
            if isinstance(properties, str):
                try:
                    properties = json.loads(
                        properties,
                        parse_constant=_reject_json_constant,
                    )
                except (RecursionError, ValueError) as error:
                    raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE) from error
            records.append({"event": row[0], "properties": properties, "timestamp": row[2]})
        return ConnectorBatch(records=tuple(records))


class MastraConnector(_HttpConnector):
    """Paginate a Mastra server's observability traces endpoint."""

    kind = TraceTransportKind.MASTRA

    def fetch_page(
        self,
        request: ConnectorRequest,
        *,
        credential: str,
        cursor: str | None,
        limit: int,
    ) -> ConnectorBatch:
        """Fetch one zero-based page using Mastra's page/perPage contract."""
        if request.since is not None:
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
        host = _safe_https_base(
            _config_text(request.config, "host") or _config_text(request.config, "project") or ""
        )
        page = _positive_cursor(cursor, start=0)
        page_limit = min(limit, HTTP_PAGE_SIZE)
        payload = self._json(
            "GET",
            f"{host}/api/observability/traces",
            headers={"Authorization": f"Bearer {credential}"},
            params={"page": str(page), "perPage": str(page_limit)},
            timeout=HTTP_TIMEOUT_SECONDS,
        )
        records = _wrapped_records(payload, keys=("spans", "traces", "data"))
        next_cursor = str(page + 1) if len(records) == page_limit else None
        return ConnectorBatch(records=tuple(records[:limit]), next_cursor=next_cursor)


class PostgresConnector:
    """Read one bounded, explicitly identified Postgres payload column."""

    kind = TraceTransportKind.POSTGRES

    def fetch_page(
        self,
        request: ConnectorRequest,
        *,
        credential: str,
        cursor: str | None,
        limit: int,
    ) -> ConnectorBatch:
        """Fetch a single deterministic page, never interpolating identifiers."""
        if cursor is not None:
            return ConnectorBatch(records=())
        table = _qualified_identifier(_required_config_text(request.config, "table"))
        payload_column = _identifier(_config_text(request.config, "payload_column") or "payload")
        order_value = _config_text(request.config, "order_column")
        order_column = _identifier(order_value) if order_value is not None else None
        if request.since is not None and order_column is None:
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
        table_identifier = sql.Identifier(*table)
        query = sql.SQL("select {} from {}").format(
            sql.Identifier(payload_column), table_identifier
        )
        params: list[object] = []
        if request.since is not None and order_column is not None:
            query += sql.SQL(" where {} >= %s").format(sql.Identifier(order_column))
            params.append(request.since)
        if order_column is not None:
            query += sql.SQL(" order by {}").format(sql.Identifier(order_column))
        query += sql.SQL(" limit %s")
        params.append(min(limit, MAX_REMOTE_RECORDS))
        try:
            with (
                psycopg.connect(credential, connect_timeout=10) as connection,
                connection.cursor() as database_cursor,
            ):
                database_cursor.execute("set local statement_timeout = '60000ms'")
                database_cursor.execute(query, params)
                rows = database_cursor.fetchall()
        except (
            psycopg.errors.InvalidPassword,
            psycopg.errors.InvalidAuthorizationSpecification,
        ) as error:
            raise ConnectorError(AcquisitionErrorCode.BAD_CREDENTIALS) from error
        except psycopg.OperationalError as error:
            raise ConnectorError(AcquisitionErrorCode.SOURCE_UNAVAILABLE) from error
        except psycopg.Error as error:
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG) from error
        records: list[JsonValue] = []
        canonical_byte_size = 0
        for row in rows:
            record = _postgres_json(row[0])
            canonical_byte_size += _json_byte_size(record) + 1
            if canonical_byte_size > MAX_TRACE_OBJECT_BYTES:
                raise ConnectorError(AcquisitionErrorCode.OBJECT_TOO_LARGE)
            records.append(record)
        return ConnectorBatch(records=tuple(records))


def _credential_pair(value: str) -> tuple[str, str]:
    """Split a Langfuse public/secret credential pair."""
    public, separator, secret = value.partition(":")
    if not separator or not public or not secret:
        raise ConnectorError(AcquisitionErrorCode.BAD_CREDENTIALS)
    return public, secret


def _config_text(config: JsonObject, key: str) -> str | None:
    """Return one nonblank string config value or fail on the wrong type."""
    value = config.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
    return value.strip()


def _required_config_text(config: JsonObject, key: str) -> str:
    """Return a required nonblank connector config value."""
    value = _config_text(config, key)
    if value is None:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
    return value


def _safe_https_base(value: str) -> str:
    """Validate a configured vendor base URL against obvious SSRF targets."""
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG) from error
    hostname = parsed.hostname
    if (
        parsed.scheme != "https"
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
    normalized_hostname = hostname.rstrip(".").casefold()
    blocked_suffixes = (".localhost", ".local", ".internal", ".home.arpa")
    if (
        normalized_hostname == "localhost"
        or "." not in normalized_hostname
        or normalized_hostname.endswith(blocked_suffixes)
    ):
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
    try:
        address = ipaddress.ip_address(normalized_hostname)
    except ValueError:
        if all(label.isdecimal() for label in normalized_hostname.split(".")):
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG) from None
    else:
        if not address.is_global:
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
    try:
        parsed_port = parsed.port
    except ValueError as error:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG) from error
    port = f":{parsed_port}" if parsed_port is not None else ""
    return f"https://{normalized_hostname}{port}"


def _positive_decimal(value: str) -> str:
    """Return a positive decimal API path identifier."""
    if not value.isdecimal() or int(value) < 1:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
    return value


def _positive_cursor(value: str | None, *, start: int) -> int:
    """Parse an integer page cursor at or above its transport's first page."""
    if value is None:
        return start
    try:
        page = int(value)
    except ValueError as error:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG) from error
    if page < start:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
    return page


def _iso_timestamp(value: str) -> str:
    """Validate and normalize an ISO-8601 timestamp passed to a vendor."""
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG) from error
    if parsed.tzinfo is None:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
    return parsed.isoformat()


def _wrapped_records(payload: JsonValue, *, keys: tuple[str, ...]) -> list[JsonValue]:
    """Extract a record list from a bare array or one known wrapper key."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in keys:
            records = payload.get(key)
            if isinstance(records, list):
                return records
    raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE)


_SQL_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")


def _identifier(value: str) -> str:
    """Validate one SQL identifier before passing it to psycopg.sql.Identifier."""
    if _SQL_IDENTIFIER.fullmatch(value) is None:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
    return value


def _qualified_identifier(value: str) -> tuple[str, ...]:
    """Validate a table name with at most one optional schema qualifier."""
    parts = tuple(value.split("."))
    if not 1 <= len(parts) <= 2:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_CONFIG)
    return tuple(_identifier(part) for part in parts)


def _postgres_json(value: object) -> JsonValue:
    """Decode one Postgres payload value into a JSON container."""
    decoded: object = value
    if isinstance(value, (str, bytes, bytearray)):
        try:
            decoded = json.loads(value, parse_constant=_reject_json_constant)
        except (RecursionError, UnicodeDecodeError, ValueError) as error:
            raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE) from error
    if not isinstance(decoded, (dict, list)):
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE)
    try:
        return _JSON_VALUE_ADAPTER.validate_python(decoded)
    except ValueError as error:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE) from error


def _reject_json_constant(value: str) -> object:
    """Reject Python's non-standard NaN and infinity JSON extensions."""
    msg = f"non-finite JSON number is not supported: {value}"
    raise ValueError(msg)


def _json_byte_size(value: JsonValue) -> int:
    """Return canonical UTF-8 size or reject a non-standard JSON value."""
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode()
    except (RecursionError, ValueError) as error:
        raise ConnectorError(AcquisitionErrorCode.INVALID_SOURCE_RESPONSE) from error
    return len(encoded)
