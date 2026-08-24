# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Broadcast: scheduled delivery of opt-in captured prompts to destinations.

The OpenRouter model. The platform table is the store of record; content
leaves it only when an org EXPLICITLY enables broadcast on a stored
observability connection (``trace_connections.config.broadcast``) — connecting
a destination for trace ingestion never implicitly ships content to it. Each
destination carries a privacy mode: when set, prompt content is stripped and
only content-free metadata (request id, model, prompt group, timing) ships.

Destinations (one per stored connection kind, several may be enabled at
once): Braintrust (its project-logs API), Langfuse and Arize Phoenix (one
shared OTLP/JSON span payload — Langfuse's classic ingestion API is sunset in
late 2026 and its documented forward path is the OTel endpoint; Phoenix is
OTel-native), LangSmith (its runs API), and PostHog (its capture batch API
using the project's public write-only ``phc_`` token, which lives in
non-secret broadcast config because PostHog itself ships it to browsers).
Mastra has no public write contract for external events and the postgres
connection is a trace SOURCE, so neither is a destination.

Deliveries carry deterministic per-destination event ids derived from the
request id, so the at-least-once retry after a partial failure is idempotent
wherever the vendor honors ids (Braintrust upserts, Langfuse/Phoenix dedupe
spans, LangSmith answers 409 which is treated as delivered, PostHog dedupes
on uuid).

Driven by the ``broadcast`` pg_cron job through the internal machine route
(same three-hop shape as the account-balance fetch). Every tick drains the
queue to empty under a wall-clock budget, batch by batch, so throughput
scales with traffic and the tick cadence only bounds latency.

Delivery is at-least-once with claim-then-ship: rows are stamped
``exported_at`` inside a transaction that re-verifies the org's CURRENT
capture consent and ships only what the claim returned, so content can never
leave after revocation. A failed ship releases the claim for the next tick.
Orgs with no enabled destination have nowhere to deliver: their rows are
stamped immediately so the queue never wedges — the platform table remains
their store of record, and enabling broadcast later ships new captures from
that point on.

The broadcaster never logs credentials or prompt content; failures reduce to
per-org counters in the returned summary.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from datetime import datetime
from typing import Protocol
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.db.stores.gateway_capture_store import CaptureExportRow, GatewayCaptureStore
from explabs.db.stores.trace_ingest_store import TraceConnectionRecord, TraceIngestStore

logger = logging.getLogger(__name__)

# Connection kinds the broadcaster can deliver to, in stable attempt order.
DESTINATION_KINDS: tuple[str, ...] = (
    "braintrust",
    "langfuse",
    "langsmith",
    "phoenix",
    "posthog",
)

_DEFAULT_HOSTS: dict[str, str] = {
    "braintrust": "https://api.braintrust.dev",
    "langfuse": "https://cloud.langfuse.com",
    "langsmith": "https://api.smith.langchain.com",
    "posthog": "https://us.posthog.com",
    # Phoenix has no universal cloud host: the connection must declare one
    # (self-hosted or the account's Phoenix Cloud space).
}

# The project/session used when the org's connection declares none: one
# per-gateway bucket keeps broadcast logs separate from whatever the org
# ingests traces from.
_DEFAULT_PROJECT_NAME = "explabs-gateway-broadcast"
_EVENT_NAME = "explabs-gateway-capture"
_BATCH_LIMIT = 100
_HTTP_TIMEOUT_SECONDS = 15.0
# One tick drains until empty or this budget elapses; the next tick (one
# minute later) picks up whatever remains.
_TICK_BUDGET_SECONDS = 45.0


class BroadcastConfig(BaseModel):
    """One destination's broadcast settings, parsed off the connection config.

    Absent or malformed config means DISABLED: broadcast is an explicit
    opt-in per destination, never a side effect of connecting one.
    """

    model_config = ConfigDict(frozen=True)

    enabled: bool = False
    # Privacy mode ships metadata only: prompt content is stripped while
    # request id, model, prompt group, and timing still flow.
    privacy_mode: bool = False
    # PostHog only: the project's public write-only capture token (phc_...).
    # PostHog embeds this token in customer web pages by design, so it is
    # config, not a Vault secret; the stored connection credential is the
    # PRIVATE personal key, which PostHog's capture API does not accept.
    capture_token: str | None = None

    @classmethod
    def from_connection_config(cls, config: JsonObject) -> BroadcastConfig:
        """Parse the ``broadcast`` object from a connection's raw config."""
        raw = config.get("broadcast")
        if not isinstance(raw, dict):
            return cls()
        try:
            return cls.model_validate(raw)
        except ValidationError:
            return cls()


class BroadcastSummary(BaseModel):
    """One tick's outcome, for the internal route's response and logs."""

    model_config = ConfigDict(frozen=True)

    broadcast: int
    skipped_no_destination: int
    failed: int


class BroadcastDestination(Protocol):
    """One enabled destination's delivery seam."""

    def deliver(self, rows: list[CaptureExportRow], *, include_content: bool) -> None:
        """Ship one claimed batch; raise on any delivery failure."""
        ...


def _metadata(row: CaptureExportRow) -> JsonObject:
    """The content-free metadata every destination receives."""
    return {
        "source": "explabs-gateway",
        "request_id": row.request_id,
        "model": row.alias,
        "prompt_group": None if row.prompt_sha256 is None else row.prompt_sha256[:12],
        "captured_at": row.captured_at,
    }


def _deterministic_uuid(kind: str, request_id: str) -> str:
    """A stable per-destination event id, so retries never duplicate."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"explabs-broadcast:{kind}:{request_id}"))


def _unix_nanos(timestamp: str) -> int:
    """An RFC 3339 capture stamp as OTLP's unix nanoseconds."""
    return int(datetime.fromisoformat(timestamp).timestamp() * 1_000_000_000)


def _host(config: JsonObject, kind: str) -> str:
    """The API host the org's connection declares, else the kind's default."""
    host = config.get("host")
    if isinstance(host, str) and host.strip().startswith("https://"):
        return host.strip().rstrip("/")
    default = _DEFAULT_HOSTS.get(kind)
    if default is None:
        msg = f"{kind} broadcast needs the connection host"
        raise ValueError(msg)
    return default


def _project(config: JsonObject) -> str:
    """The project the org's connection declares, else the broadcast default."""
    project = config.get("project")
    if isinstance(project, str) and project.strip():
        return project.strip()
    return _DEFAULT_PROJECT_NAME


def _http_client(
    transport: httpx.BaseTransport | None,
    *,
    headers: dict[str, str] | None = None,
    auth: httpx.Auth | None = None,
) -> httpx.Client:
    """One bounded client per delivery; the transport is test-injectable."""
    return httpx.Client(
        timeout=_HTTP_TIMEOUT_SECONDS, transport=transport, headers=headers, auth=auth
    )


def _otlp_attribute(key: str, value: str) -> JsonObject:
    """One OTLP string attribute."""
    return {"key": key, "value": {"stringValue": value}}


def _otlp_payload(rows: list[CaptureExportRow], *, include_content: bool) -> JsonObject:
    """One OTLP/JSON trace export shared by the OTel-native destinations.

    Attributes follow the GenAI/OpenInference conventions both Langfuse and
    Phoenix document: ``llm.model_name``/``gen_ai.request.model`` for the
    model and ``input.value`` for the prompt. Trace/span ids derive from the
    request id, so a replayed batch lands on the same spans.
    """
    spans: list[JsonObject] = []
    for row in rows:
        nanos = _unix_nanos(row.captured_at)
        attributes = [
            _otlp_attribute("openinference.span.kind", "LLM"),
            _otlp_attribute("llm.model_name", row.alias),
            _otlp_attribute("gen_ai.request.model", row.alias),
            _otlp_attribute("explabs.request_id", row.request_id),
        ]
        if row.prompt_sha256 is not None:
            attributes.append(_otlp_attribute("explabs.prompt_group", row.prompt_sha256[:12]))
        if include_content:
            attributes.append(_otlp_attribute("input.value", json.dumps(list(row.messages))))
        digest = hashlib.sha256(f"explabs-broadcast:{row.request_id}".encode()).hexdigest()
        spans.append(
            {
                "traceId": digest[:32],
                "spanId": digest[32:48],
                "name": _EVENT_NAME,
                "kind": 1,
                "startTimeUnixNano": str(nanos),
                "endTimeUnixNano": str(nanos),
                "attributes": attributes,
            }
        )
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": [_otlp_attribute("service.name", "explabs-gateway")]},
                "scopeSpans": [{"scope": {"name": "explabs-gateway-broadcast"}, "spans": spans}],
            }
        ]
    }


class BraintrustDestination:
    """Braintrust project logs: resolve the project, insert id-keyed events."""

    def __init__(
        self,
        *,
        credential: str,
        connection_config: JsonObject,
        transport: httpx.BaseTransport | None,
    ) -> None:
        """Bind the connection's credential, host, and project."""
        self._host = _host(connection_config, "braintrust")
        self._project = _project(connection_config)
        self._credential = credential
        self._transport = transport

    def deliver(self, rows: list[CaptureExportRow], *, include_content: bool) -> None:
        """Insert one batch of events; the event id makes retries upsert."""
        events: list[JsonObject] = []
        for row in rows:
            event: dict[str, object] = {"id": row.request_id, "metadata": _metadata(row)}
            if include_content:
                event["input"] = list(row.messages)
            events.append(event)
        with _http_client(
            self._transport, headers={"Authorization": f"Bearer {self._credential}"}
        ) as http:
            project = http.post(f"{self._host}/v1/project", json={"name": self._project})
            project.raise_for_status()
            project_id = project.json().get("id")
            if not isinstance(project_id, str) or not project_id:
                msg = "braintrust project resolution returned no id"
                raise RuntimeError(msg)
            response = http.post(
                f"{self._host}/v1/project_logs/{quote(project_id, safe='')}/insert",
                json={"events": events},
            )
            response.raise_for_status()


class LangfuseDestination:
    """Langfuse via its OTel endpoint (the classic ingestion API is sunset)."""

    def __init__(
        self,
        *,
        credential: str,
        connection_config: JsonObject,
        transport: httpx.BaseTransport | None,
    ) -> None:
        """Split the stored public:secret pair and bind the OTLP endpoint."""
        public_key, separator, secret_key = credential.partition(":")
        if not separator or not public_key or not secret_key:
            msg = "langfuse broadcast needs a public:secret credential pair"
            raise ValueError(msg)
        self._auth = httpx.BasicAuth(public_key, secret_key)
        self._url = f"{_host(connection_config, 'langfuse')}/api/public/otel/v1/traces"
        self._transport = transport

    def deliver(self, rows: list[CaptureExportRow], *, include_content: bool) -> None:
        """POST one OTLP/JSON export; Langfuse accepts HTTP/JSON explicitly."""
        with _http_client(self._transport, auth=self._auth) as http:
            response = http.post(
                self._url, json=_otlp_payload(rows, include_content=include_content)
            )
            response.raise_for_status()


class PhoenixDestination:
    """Arize Phoenix via OTLP/JSON at the deployment's /v1/traces."""

    def __init__(
        self,
        *,
        credential: str,
        connection_config: JsonObject,
        transport: httpx.BaseTransport | None,
    ) -> None:
        """Bind the connection's declared host (Phoenix has no default)."""
        # Both header spellings cover Phoenix Cloud (api_key) and
        # authenticated self-hosted deployments (Authorization: Bearer).
        self._headers = {"Authorization": f"Bearer {credential}", "api_key": credential}
        self._url = f"{_host(connection_config, 'phoenix')}/v1/traces"
        self._transport = transport

    def deliver(self, rows: list[CaptureExportRow], *, include_content: bool) -> None:
        """POST one OTLP/JSON export to the Phoenix collector."""
        with _http_client(self._transport, headers=self._headers) as http:
            response = http.post(
                self._url, json=_otlp_payload(rows, include_content=include_content)
            )
            response.raise_for_status()


class LangsmithDestination:
    """LangSmith runs API: one llm-typed run per captured request."""

    def __init__(
        self,
        *,
        credential: str,
        connection_config: JsonObject,
        transport: httpx.BaseTransport | None,
    ) -> None:
        """Bind the endpoint, session (project), and API key header."""
        self._endpoint = _host(connection_config, "langsmith")
        self._session = _project(connection_config)
        self._headers = {"x-api-key": credential}
        self._transport = transport

    def deliver(self, rows: list[CaptureExportRow], *, include_content: bool) -> None:
        """POST each run; a 409 on the deterministic id means already delivered."""
        with _http_client(self._transport, headers=self._headers) as http:
            for row in rows:
                body: dict[str, object] = {
                    "id": _deterministic_uuid("langsmith", row.request_id),
                    "name": _EVENT_NAME,
                    "run_type": "llm",
                    "start_time": row.captured_at,
                    "end_time": row.captured_at,
                    "inputs": {"messages": list(row.messages)} if include_content else {},
                    "extra": {"metadata": _metadata(row)},
                    "session_name": self._session,
                }
                response = http.post(f"{self._endpoint}/api/v1/runs", json=body)
                if response.status_code == 409:
                    continue
                response.raise_for_status()


class PostHogDestination:
    """PostHog capture batch: $ai_generation events under the project token."""

    def __init__(
        self,
        *,
        config: BroadcastConfig,
        connection_config: JsonObject,
        transport: httpx.BaseTransport | None,
    ) -> None:
        """Bind the host and the public write-only capture token."""
        if config.capture_token is None or not config.capture_token.strip():
            msg = "posthog broadcast needs the project capture token (phc_...)"
            raise ValueError(msg)
        self._token = config.capture_token.strip()
        self._host = _host(connection_config, "posthog")
        self._transport = transport

    def deliver(self, rows: list[CaptureExportRow], *, include_content: bool) -> None:
        """POST one capture batch; the deterministic uuid dedupes retries."""
        batch: list[JsonObject] = []
        for row in rows:
            properties: dict[str, object] = {
                "$ai_model": row.alias,
                "$ai_provider": "explabs-gateway",
                "explabs_request_id": row.request_id,
                "explabs_prompt_group": None
                if row.prompt_sha256 is None
                else row.prompt_sha256[:12],
            }
            if include_content:
                properties["$ai_input"] = list(row.messages)
            batch.append(
                {
                    "event": "$ai_generation",
                    "distinct_id": "explabs-gateway",
                    "uuid": _deterministic_uuid("posthog", row.request_id),
                    "timestamp": row.captured_at,
                    "properties": properties,
                }
            )
        with _http_client(self._transport) as http:
            response = http.post(
                f"{self._host}/batch/", json={"api_key": self._token, "batch": batch}
            )
            response.raise_for_status()


def _destination(
    kind: str,
    *,
    credential: str,
    connection_config: JsonObject,
    config: BroadcastConfig,
    transport: httpx.BaseTransport | None,
) -> BroadcastDestination:
    """Build the delivery adapter for one enabled destination kind."""
    match kind:
        case "braintrust":
            return BraintrustDestination(
                credential=credential, connection_config=connection_config, transport=transport
            )
        case "langfuse":
            return LangfuseDestination(
                credential=credential, connection_config=connection_config, transport=transport
            )
        case "phoenix":
            return PhoenixDestination(
                credential=credential, connection_config=connection_config, transport=transport
            )
        case "langsmith":
            return LangsmithDestination(
                credential=credential, connection_config=connection_config, transport=transport
            )
        case "posthog":
            return PostHogDestination(
                config=config, connection_config=connection_config, transport=transport
            )
        case _:
            msg = f"unknown broadcast destination kind: {kind}"
            raise ValueError(msg)


_EnabledDestination = tuple[str, TraceConnectionRecord, BroadcastConfig]


def _enabled_destinations(connections: TraceIngestStore, org_id: str) -> list[_EnabledDestination]:
    """The org's connections with broadcast explicitly switched on."""
    enabled: list[_EnabledDestination] = []
    for kind in DESTINATION_KINDS:
        connection = connections.find_connection(org_id, kind)
        if connection is None:
            continue
        config = BroadcastConfig.from_connection_config(connection.config)
        if config.enabled:
            enabled.append((kind, connection, config))
    return enabled


def _ship_org_rows(
    connections: TraceIngestStore,
    enabled: list[_EnabledDestination],
    ship_rows: list[CaptureExportRow],
    transport: httpx.BaseTransport | None,
) -> None:
    """Deliver one claimed batch to every enabled destination; raise on failure."""
    for kind, connection, config in enabled:
        credential = connections.release_credential(connection.id)
        _destination(
            kind,
            credential=credential,
            connection_config=connection.config,
            config=config,
            transport=transport,
        ).deliver(ship_rows, include_content=not config.privacy_mode)


def run_broadcast(
    client: SupabaseClient,
    *,
    transport: httpx.BaseTransport | None = None,
) -> BroadcastSummary:
    """Drain the broadcast queue until empty or the tick budget elapses.

    Args:
        client: Service-role Supabase client.
        transport: Test-injectable HTTP transport for the destination calls.

    Returns:
        The tick's summary; failed rows stay queued for the next tick.
    """
    captures = GatewayCaptureStore(client)
    connections = TraceIngestStore(client)
    deadline = time.monotonic() + _TICK_BUDGET_SECONDS
    broadcast = 0
    skipped = 0
    failed = 0
    # Orgs with a destination failure this tick: their remaining rows stay
    # queued (unclaimed) rather than hammering a down destination in-loop.
    failed_orgs: set[str] = set()

    while time.monotonic() < deadline:
        rows = captures.to_export(limit=_BATCH_LIMIT, exclude_orgs=tuple(failed_orgs))
        if not rows:
            break

        by_org: dict[str, list[CaptureExportRow]] = {}
        for row in rows:
            by_org.setdefault(row.org_id, []).append(row)

        progressed = 0
        newly_failed = False
        for org_id, org_rows in by_org.items():
            enabled = _enabled_destinations(connections, org_id)
            if not enabled:
                # Nowhere to deliver: the platform table is this org's store
                # of record. Claim the rows so the queue never wedges on them.
                claimed = captures.mark_exported(tuple(row.request_id for row in org_rows))
                skipped += len(claimed)
                progressed += len(claimed)
                continue
            # CLAIM before shipping: the stamp re-verifies consent
            # transactionally and returns exactly the claimable ids, so a
            # revocation landing after the queue read can never leak content
            # externally. A crash between claim and ship costs one external
            # delivery, never consent.
            claimed_ids = captures.mark_exported(tuple(row.request_id for row in org_rows))
            if not claimed_ids:
                continue
            claimed_set = set(claimed_ids)
            ship_rows = [row for row in org_rows if row.request_id in claimed_set]
            try:
                _ship_org_rows(connections, enabled, ship_rows, transport)
            except (httpx.HTTPError, RuntimeError, ValueError):
                # Release the claim; the next tick retries every destination
                # (still consent-gated, and deterministic event ids keep the
                # redelivery idempotent where the vendor honors them). Never
                # log content or keys.
                captures.unmark_exported(claimed_ids)
                logger.warning(
                    "broadcast failed for org %s (%d rows)",
                    org_id,
                    len(ship_rows),
                    exc_info=True,
                )
                failed += len(ship_rows)
                failed_orgs.add(org_id)
                newly_failed = True
                continue
            broadcast += len(claimed_ids)
            progressed += len(claimed_ids)

        if len(rows) < _BATCH_LIMIT or (progressed == 0 and not newly_failed):
            # The queue is drained past this batch, or nothing moved and no
            # new exclusion can unblock the next fetch (every claim refused
            # under revoked consent). A fresh failure keeps the loop alive:
            # the next fetch excludes that org and reaches rows behind it.
            break

    return BroadcastSummary(broadcast=broadcast, skipped_no_destination=skipped, failed=failed)


def summary_payload(summary: BroadcastSummary) -> dict[str, int]:
    """Project the summary for the internal route's JSON response."""
    return json.loads(summary.model_dump_json())
