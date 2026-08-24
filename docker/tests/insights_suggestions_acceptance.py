# Copyright (c) 2026 Experiential Labs. All rights reserved.
# ruff: noqa: INP001 -- executable backend acceptance smoke.

"""Live-traffic proof for the Insights suggestions pipeline.

Drives real streamed chat completions through the private gateway worker with
the official OpenAI client — no funded provider, the loopback provider lives in
this process — and then proves the whole advice chain on the rows that traffic
settled: exact subset-priced costs and cached-token counts on
``gateway_usage_events``, the cached sum on the ``gateway_usage_timeseries``
RPC, the content-free request lineage the worker derives at authorize
(prompt/conversation digests, explabs/gateway/lineage.py), and the interim
suggestions engine emitting the group-scoped caching and cheaper-model advice
whose dollar arithmetic matches the observed ledger.

Two org-owned aliases shadow launch-catalog slugs so the catalog-priced rules
can fire on live traffic:

* ``claude-fable-5``: 25 prompt-heavy requests (20,000 input / 500 output)
  resending one system prompt, five of them reporting 2,000 cached input
  tokens -> lineage groups them and the caching workflow prices the group's
  actual repeated prefix.
* ``claude-opus-5``: 30 small requests (1,000 input / 200 output) -> the
  cheaper-model (Claude Sonnet 5) suggestion.

Alias resolution prefers the caller org's row over the public namespace, so
these shadows never disturb any seeded public catalog rows, and cleanup is
scoped to this run's org.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import httpx
import psycopg
from exp.runtime.gateway.contracts import (
    GatewayApiSurface,
    GatewayMessage,
    GatewayRequest,
)
from openai import OpenAI, OpenAIError, Stream
from openai.types.chat import ChatCompletionChunk
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from explabs.api.suggestions import generate_suggestions
from explabs.db.stores.gateway_usage_store import (
    GatewayPromptUsageRow,
    GatewayUsageBucketRow,
    GatewayUsageEventRow,
)
from explabs.gateway.lineage import RequestLineage, compute_request_lineage

_READY_DEADLINE_SECONDS = 120.0
# The worker's catalog refresher polls every 15s; two cycles plus margin.
_CATALOG_DEADLINE_SECONDS = 90.0

_CACHED_MARKER = "cached"

# The stable prefix every fable request resends: ~6,000 characters, so the
# worker-derived lineage estimates a 1,500-token cacheable prefix.
_SYSTEM_PROMPT = "You are the acceptance agent. " * 200

# Fable lane: prompt-heavy traffic. Loopback usage and list prices ($10/M
# input, $1/M cached input, $50/M output) mirror the launch catalog entry.
_FABLE_REQUESTS = 25
_FABLE_CACHED_REQUESTS = 5
_FABLE_INPUT_TOKENS = 20_000
_FABLE_CACHED_TOKENS = 2_000
_FABLE_OUTPUT_TOKENS = 500
# Subset-priced micro-USD per request under the frozen rates below.
_FABLE_UNCACHED_COST = 225_000
_FABLE_CACHED_COST = 207_000

# Opus lane: small requests. List prices $5/M input, $0.50/M cached, $25/M out.
_OPUS_REQUESTS = 30
_OPUS_INPUT_TOKENS = 1_000
_OPUS_OUTPUT_TOKENS = 200
_OPUS_COST = 10_000

# The engine's expected advice on this traffic, "7d" window (x 30/7 monthly).
# The fable group has 25 requests across 2 conversations ("cached hello" and
# "hello" seed turns) repeating a 1,500-token prefix:
#   caching: 1,500 * (23 reads * ($10-$1)/M - 2 writes * $10/M * 25%)
#            = $0.303 the window -> $1.30
#   cheaper: $0.30 observed vs Sonnet-5 list $0.18 = $0.12 -> $0.51
# The caching id carries the prompt digest, resolved at runtime.
_EXPECTED_CHEAPER = {"cheaper_model:claude-opus-5": "0.51"}
_EXPECTED_CACHING_SAVINGS = "1.30"
_EXPECTED_PREFIX_CHARS = len(_SYSTEM_PROMPT)


class AcceptanceError(RuntimeError):
    """The insights suggestions acceptance observed a contract violation."""


class _LoopbackProvider(BaseHTTPRequestHandler):
    """Serve one finite OpenAI-compatible SSE completion per dispatch.

    Usage counts depend on the dispatched model id and on whether the user
    message carries the cached marker, so the test controls the exact token
    mix the worker settles.
    """

    def do_POST(self) -> None:
        """Stream text, usage, and terminal frames for one provider request."""
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length))
        if payload.get("stream") is not True:
            self.send_response(400)
            self.end_headers()
            return
        model = str(payload.get("model", ""))
        content = next(
            (
                str(message.get("content", ""))
                for message in payload.get("messages", [])
                if message.get("role") == "user"
            ),
            "",
        )
        if model == "loopback-fable":
            usage: dict[str, object] = {
                "prompt_tokens": _FABLE_INPUT_TOKENS,
                "completion_tokens": _FABLE_OUTPUT_TOKENS,
                "prompt_tokens_details": {
                    "cached_tokens": (
                        _FABLE_CACHED_TOKENS if content.startswith(_CACHED_MARKER) else 0
                    )
                },
            }
        else:
            usage = {
                "prompt_tokens": _OPUS_INPUT_TOKENS,
                "completion_tokens": _OPUS_OUTPUT_TOKENS,
                "prompt_tokens_details": {"cached_tokens": 0},
            }
        frames = (
            _frame(
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": "ok"},
                            "finish_reason": "stop",
                        }
                    ]
                }
            ),
            _frame({"choices": [], "usage": usage}),
            b"data: [DONE]\n\n",
        )
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for frame in frames:
            self.wfile.write(frame)
            self.wfile.flush()

    def log_message(self, format: str, *args: object) -> None:
        """Suppress request logs so output never retains payload context."""
        del format, args


def _frame(payload: dict[str, object]) -> bytes:
    """Encode one provider SSE data frame."""
    return b"data: " + json.dumps(payload).encode() + b"\n\n"


def _own_network_address(worker_url: str) -> str:
    """Resolve the address the worker can dispatch back to."""
    explicit = os.environ.get("EXPLABS_ACCEPTANCE_HOST", "").strip()
    if explicit:
        return explicit
    host = httpx.URL(worker_url).host
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        probe.connect((host, 1))
        return str(probe.getsockname()[0])


def _wait_ready(worker_url: str) -> None:
    """Wait for /health/live and a fully ready /health/ready."""
    with httpx.Client(base_url=worker_url, timeout=5.0) as client:
        live = client.get("/health/live")
        if live.status_code != 200:
            msg = f"gateway worker liveness answered {live.status_code}"
            raise AcceptanceError(msg)
        deadline = time.monotonic() + _READY_DEADLINE_SECONDS
        last: str = "<no response>"
        while time.monotonic() < deadline:
            ready = client.get("/health/ready")
            last = f"{ready.status_code} {ready.text}"
            if ready.status_code == 200:
                return
            time.sleep(2.0)
    msg = f"gateway worker never became ready; last saw {last}"
    raise AcceptanceError(msg)


def _seed_rows(
    connection: psycopg.Connection,
    *,
    org_id: str,
    api_key_id: str,
    raw_key: str,
    models: tuple[tuple[str, str, str, str, int, int, int], ...],
    base_url: str,
) -> None:
    """Insert the org, key, and price-carrying loopback model rows.

    Args:
        connection: Autocommit database connection.
        org_id: This run's organization id.
        api_key_id: This run's xpl_ key id.
        raw_key: The raw xpl_ key material.
        models: (model_id, provider_row_id, slug, provider_model_id,
            input_rate, cached_rate, output_rate) per alias; rates in
            micro-USD per million tokens.
        base_url: The loopback provider's /v1 origin.
    """
    connection.execute(
        "insert into public.organizations (id, slug, name, capture_prompt_content)"
        " values (%s, %s, 'Insights Suggestions Acceptance', true)",
        (org_id, f"ins-accept-{org_id[:13]}"),
    )
    # Deny-by-default (P-B): a key hangs off an identity, and authorization
    # needs a gateway_grants row for that identity and the served alias. Seed
    # the org's default identity exactly as P-A's backfill does; the grants are
    # added once the worker's catalog refresher has created the org-scoped
    # aliases (see _grant_default_identity).
    connection.execute(
        "insert into public.gateway_identities (identity_id, org_id, display_name)"
        " values (%s, %s, 'Default') on conflict (identity_id) do nothing",
        (f"org-{org_id}", org_id),
    )
    connection.execute(
        """
        insert into public.api_keys (id, org_id, name, key_prefix, key_hash, identity_id)
        values (%s, %s, 'insights-suggestions-acceptance', %s, %s, %s)
        """,
        (
            api_key_id,
            org_id,
            raw_key[:12],
            hashlib.sha256(raw_key.encode()).hexdigest(),
            f"org-{org_id}",
        ),
    )
    for (
        model_id,
        provider_row_id,
        slug,
        provider_model_id,
        in_rate,
        cached_rate,
        out_rate,
    ) in models:
        connection.execute(
            "insert into public.models (id, slug, display_name, owning_org_id)"
            " values (%s, %s, %s, %s)",
            (model_id, slug, f"Insights Acceptance {slug}", org_id),
        )
        connection.execute(
            """
            insert into public.model_providers (
              id, model_id, provider, provider_model_id, base_url, owning_org_id,
              billing_source, capabilities,
              input_micro_usd_per_million, cached_input_micro_usd_per_million,
              output_micro_usd_per_million
            ) values (%s, %s, 'local', %s, %s, %s, 'customer_managed', %s, %s, %s, %s)
            """,
            (
                provider_row_id,
                model_id,
                provider_model_id,
                base_url,
                org_id,
                Jsonb({"supports_streaming": True, "reports_cached_input_tokens": True}),
                in_rate,
                cached_rate,
                out_rate,
            ),
        )


def _wait_for_org_aliases(
    connection: psycopg.Connection, org_id: str, slugs: tuple[str, ...]
) -> None:
    """Wait until the worker's catalog refresher registers the ORG-scoped aliases.

    Polling /v1/models is not enough here: the slugs shadow launch-catalog
    names a seeded public alias may already serve, and dispatch only reaches
    the loopback once the org-scoped rows exist.
    """
    deadline = time.monotonic() + _CATALOG_DEADLINE_SECONDS
    remaining: set[str] = set(slugs)
    while time.monotonic() < deadline:
        rows = connection.execute(
            """
            select aliases.alias_name from public.gateway_aliases aliases
             where aliases.org_id = %s
               and exists (
                 select 1 from public.gateway_alias_revisions revisions
                  where revisions.alias_id = aliases.alias_id
               )
            """,
            (org_id,),
        ).fetchall()
        remaining = set(slugs) - {row[0] for row in rows}
        if not remaining:
            return
        time.sleep(3.0)
    msg = f"org aliases never registered with a revision: {sorted(remaining)!r}"
    raise AcceptanceError(msg)


def _grant_default_identity(
    connection: psycopg.Connection, org_id: str, slugs: tuple[str, ...]
) -> None:
    """Grant the org's default identity its own org-scoped aliases.

    Deny-by-default (P-B) authorizes a request only when a gateway_grants row
    exists for (identity_id, alias_id); shadowing is resolved BEFORE the grant
    check, so the org-scoped shadow of a public catalog name denies until
    granted. Mirrors gateway_worker_acceptance's grant step. Runs after
    _wait_for_org_aliases so the alias rows exist.
    """
    for slug in slugs:
        granted = connection.execute(
            """
            insert into public.gateway_grants (org_id, identity_id, alias_id)
            select %s, %s, aliases.alias_id
              from public.gateway_aliases aliases
             where aliases.alias_name = %s and aliases.active
               and aliases.org_id = %s
            on conflict do nothing
            returning alias_id
            """,
            (org_id, f"org-{org_id}", slug, org_id),
        ).fetchone()
        if granted is None:
            msg = f"no org-scoped alias {slug!r} to grant after catalog refresh"
            raise AcceptanceError(msg)


def _probe_aliases(client: OpenAI, slugs: tuple[str, ...]) -> None:
    """Retry one probe stream per alias until dispatch reaches the loopback.

    The org-scoped alias rows exist in the database before the worker's
    in-memory catalog necessarily serves them (and a seeded PUBLIC alias may
    shadow the name until then), so the first dispatch per alias is retried.
    The probes' ledger rows are wiped before the counted traffic runs.
    """
    deadline = time.monotonic() + _CATALOG_DEADLINE_SECONDS
    for slug in slugs:
        last = "<not attempted>"
        while True:
            try:
                _drain(
                    client.chat.completions.create(
                        model=slug,
                        messages=[{"role": "user", "content": "probe"}],
                        stream=True,
                    )
                )
                break
            except (OpenAIError, httpx.HTTPError, AcceptanceError) as error:
                last = f"{type(error).__name__}: {error}"
            if time.monotonic() >= deadline:
                msg = f"alias {slug!r} never dispatched to the loopback; last saw {last}"
                raise AcceptanceError(msg)
            time.sleep(3.0)


def _reset_ledger(connection: psycopg.Connection, org_id: str) -> None:
    """Wipe the org's probe-phase ledger rows so counted traffic starts clean."""
    connection.execute("set session_replication_role = replica")
    try:
        for table in (
            "gateway_captured_prompts",
            "gateway_usage_daily",
            "gateway_usage_events",
            "gateway_attempts",
            "gateway_requests",
        ):
            connection.execute(
                f"delete from public.{table} where org_id = %s",
                (org_id,),
            )
    finally:
        connection.execute("set session_replication_role = origin")


def _stream_traffic(client: OpenAI) -> None:
    """Stream the two aliases' live traffic through the official client."""
    for index in range(_FABLE_REQUESTS):
        content = "cached hello" if index < _FABLE_CACHED_REQUESTS else "hello"
        _drain(
            client.chat.completions.create(
                model="claude-fable-5",
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": content},
                ],
                stream=True,
            )
        )
    for _ in range(_OPUS_REQUESTS):
        _drain(
            client.chat.completions.create(
                model="claude-opus-5",
                messages=[{"role": "user", "content": "hi"}],
                stream=True,
            )
        )


def _drain(stream: Stream[ChatCompletionChunk]) -> None:
    """Consume one completion stream and require non-empty content."""
    parts: list[str] = []
    for chunk in stream:
        parts.extend(
            choice.delta.content
            for choice in chunk.choices
            if choice.delta and choice.delta.content
        )
    if "".join(parts) != "ok":
        msg = f"streamed completion returned {''.join(parts)!r}, expected 'ok'"
        raise AcceptanceError(msg)


def _assert_ledger(connection: psycopg.Connection, org_id: str) -> None:
    """Every settled event carries subset-priced money and its cached count."""
    rows = connection.execute(
        """
        select alias, cached_input_tokens, estimated_cost_micro_usd, cost_micro_usd,
               pricing_known, status, lane
          from public.gateway_usage_events where org_id = %s
        """,
        (org_id,),
    ).fetchall()
    if len(rows) != _FABLE_REQUESTS + _OPUS_REQUESTS:
        msg = f"expected {_FABLE_REQUESTS + _OPUS_REQUESTS} usage events, saw {len(rows)}"
        raise AcceptanceError(msg)
    expected_cells = {
        ("claude-fable-5", _FABLE_CACHED_TOKENS, _FABLE_CACHED_COST): _FABLE_CACHED_REQUESTS,
        ("claude-fable-5", 0, _FABLE_UNCACHED_COST): _FABLE_REQUESTS - _FABLE_CACHED_REQUESTS,
        ("claude-opus-5", 0, _OPUS_COST): _OPUS_REQUESTS,
    }
    observed_cells: dict[tuple[str, int, int], int] = {}
    for alias, cached, estimated, cost, pricing_known, status, lane in rows:
        if (cost, pricing_known, status, lane) != (0, True, "completed", "pass_through"):
            msg = f"unexpected event shape for {alias}: {(cost, pricing_known, status, lane)!r}"
            raise AcceptanceError(msg)
        cell = (alias, int(cached), int(estimated))
        observed_cells[cell] = observed_cells.get(cell, 0) + 1
    if observed_cells != expected_cells:
        msg = (
            "settled (alias, cached, estimated) cells diverge: "
            f"observed {observed_cells!r}, expected {expected_cells!r}"
        )
        raise AcceptanceError(msg)


def _expected_fable_lineage() -> RequestLineage:
    """Recompute the fable lineage client-side, exactly as the worker does."""
    return compute_request_lineage(
        GatewayRequest(
            surface=GatewayApiSurface.CHAT_COMPLETIONS,
            messages=(
                GatewayMessage(role="system", content=_SYSTEM_PROMPT),
                GatewayMessage(role="user", content="hello"),
            ),
            stream=True,
        )
    )


def _assert_lineage(connection: psycopg.Connection, org_id: str) -> str:
    """The worker-persisted lineage matches a client-side recompute.

    Returns:
        The fable traffic's prompt digest (the caching card's group).
    """
    expected_prompt = _expected_fable_lineage().prompt_sha256
    rows = connection.execute(
        """
        select prompt_sha256, count(distinct conversation_sha256),
               max(stable_prefix_chars)
          from public.gateway_usage_events
         where org_id = %s and alias = 'claude-fable-5'
         group by prompt_sha256
        """,
        (org_id,),
    ).fetchall()
    if len(rows) != 1:
        msg = f"fable traffic split across {len(rows)} prompt groups, expected 1"
        raise AcceptanceError(msg)
    prompt_sha256, conversations, prefix_chars = rows[0]
    if prompt_sha256 != expected_prompt:
        msg = (
            "worker-persisted prompt digest diverges from the client-side "
            f"recompute: {prompt_sha256!r} != {expected_prompt!r}"
        )
        raise AcceptanceError(msg)
    if int(conversations) != 2 or int(prefix_chars) != _EXPECTED_PREFIX_CHARS:
        msg = (
            f"fable lineage shape diverges: {conversations} conversations, "
            f"{prefix_chars} prefix chars"
        )
        raise AcceptanceError(msg)
    return str(prompt_sha256)


def _assert_capture(connection: psycopg.Connection, org_id: str, prompt_sha256: str) -> None:
    """The opted-in org's prompts persisted with content intact.

    The capture writer is asynchronous, so this polls to a deadline; content
    is compared exactly against what the official client sent.
    """
    expected = _FABLE_REQUESTS + _OPUS_REQUESTS
    deadline = time.monotonic() + 30.0
    count = 0
    while time.monotonic() < deadline:
        row = connection.execute(
            "select count(*) from public.gateway_captured_prompts where org_id = %s",
            (org_id,),
        ).fetchone()
        count = int(row[0]) if row is not None else 0
        if count >= expected:
            break
        time.sleep(1.0)
    if count != expected:
        msg = f"captured {count} prompts, expected {expected}"
        raise AcceptanceError(msg)
    sample = connection.execute(
        """
        select captured.messages
          from public.gateway_captured_prompts captured
          join public.gateway_requests requests
            on requests.request_id = captured.request_id
         where captured.org_id = %s and requests.alias = 'claude-fable-5'
         limit 1
        """,
        (org_id,),
    ).fetchone()
    if sample is None:
        msg = "no captured fable prompt found"
        raise AcceptanceError(msg)
    messages = sample[0]
    if (
        messages[0]["role"] != "system"
        or messages[0]["content"] != _SYSTEM_PROMPT
        or messages[1]["role"] != "user"
    ):
        msg = "captured messages diverge from what the client sent"
        raise AcceptanceError(msg)
    snippet_row = connection.execute(
        "select snippet from public.gateway_prompt_group_snippets(%s::uuid)"
        " where prompt_sha256 = %s",
        (org_id, prompt_sha256),
    ).fetchone()
    if snippet_row is None or not _SYSTEM_PROMPT.startswith(str(snippet_row[0])[:30]):
        msg = f"group snippet diverges: {snippet_row!r}"
        raise AcceptanceError(msg)


def _assert_suggestions(connection: psycopg.Connection, org_id: str, prompt_sha256: str) -> None:
    """The real RPCs feed the real engine, which emits the expected advice."""
    with connection.cursor(row_factory=dict_row) as cursor:
        bucket_rows = cursor.execute(
            "select * from public.gateway_usage_timeseries(%s::uuid, null, 86400)",
            (org_id,),
        ).fetchall()
        event_rows = cursor.execute(
            "select * from public.list_gateway_usage_events(%s::uuid, in_limit => 200)",
            (org_id,),
        ).fetchall()
        prompt_rows = cursor.execute(
            "select * from public.gateway_usage_by_prompt(%s::uuid)",
            (org_id,),
        ).fetchall()
    buckets = tuple(GatewayUsageBucketRow.from_row(_stringly(row)) for row in bucket_rows)
    events = tuple(GatewayUsageEventRow.from_row(_stringly(row)) for row in event_rows)
    prompts = tuple(GatewayPromptUsageRow.from_row(_stringly(row)) for row in prompt_rows)
    cached_total = sum(bucket.cached_input_tokens for bucket in buckets)
    expected_cached = _FABLE_CACHED_REQUESTS * _FABLE_CACHED_TOKENS
    if cached_total != expected_cached:
        msg = f"timeseries cached_input_tokens sum {cached_total}, expected {expected_cached}"
        raise AcceptanceError(msg)
    suggestions = generate_suggestions(buckets, events, "7d", prompts=prompts)
    observed = {
        suggestion.id: suggestion.estimated_monthly_savings_usd for suggestion in suggestions
    }
    expected = dict(_EXPECTED_CHEAPER)
    expected[f"caching:claude-fable-5:{prompt_sha256[:12]}"] = _EXPECTED_CACHING_SAVINGS
    if observed != expected:
        msg = f"suggestions diverge: observed {observed!r}, expected {expected!r}"
        raise AcceptanceError(msg)
    ordered = [suggestion.id for suggestion in suggestions]
    if ordered != sorted(ordered, key=lambda sid: -float(expected[sid])):
        msg = f"suggestions are not ordered by estimated savings: {ordered!r}"
        raise AcceptanceError(msg)


def _stringly(row: dict[str, object]) -> dict[str, object]:
    """Coerce RPC row values the typed models expect as strings."""
    coerced = dict(row)
    for key in ("bucket_start", "created_at", "last_used_at"):
        if key in coerced and coerced[key] is not None:
            coerced[key] = str(coerced[key])
    for key in ("api_key_id",):
        if key in coerced and coerced[key] is not None:
            coerced[key] = str(coerced[key])
    return coerced


def _cleanup(
    connection: psycopg.Connection,
    *,
    org_id: str,
    model_ids: tuple[str, ...],
) -> None:
    """Remove every seeded and worker-registered row for this run's org."""
    connection.execute("set session_replication_role = replica")
    try:
        for table in (
            "gateway_captured_prompts",
            "gateway_usage_daily",
            "gateway_usage_events",
            "gateway_attempts",
            "gateway_requests",
        ):
            connection.execute(
                f"delete from public.{table} where org_id = %s",
                (org_id,),
            )
        snapshot_rows = connection.execute(
            """
            select distinct catalog_sha256 from public.gateway_alias_revisions
             where alias_id in (
               select alias_id from public.gateway_aliases where org_id = %s
             )
            """,
            (org_id,),
        ).fetchall()
        connection.execute(
            """
            delete from public.gateway_alias_revisions where alias_id in (
              select alias_id from public.gateway_aliases where org_id = %s
            )
            """,
            (org_id,),
        )
        connection.execute("delete from public.gateway_aliases where org_id = %s", (org_id,))
        for (catalog_sha256,) in snapshot_rows:
            # Snapshots hash one org's catalog; drop only when nothing else
            # (e.g. a public alias) still references them.
            connection.execute(
                """
                delete from public.gateway_catalog_snapshots snapshots
                 where snapshots.catalog_sha256 = %s
                   and not exists (
                     select 1 from public.gateway_alias_revisions revisions
                      where revisions.catalog_sha256 = snapshots.catalog_sha256
                   )
                """,
                (catalog_sha256,),
            )
        for model_id in model_ids:
            connection.execute(
                "delete from public.model_providers where model_id = %s", (model_id,)
            )
            connection.execute("delete from public.models where id = %s", (model_id,))
        connection.execute("delete from public.credit_ledger where org_id = %s", (org_id,))
        connection.execute("delete from public.gateway_grants where org_id = %s", (org_id,))
        connection.execute("delete from public.api_keys where org_id = %s", (org_id,))
        connection.execute("delete from public.gateway_identities where org_id = %s", (org_id,))
        connection.execute("delete from public.organizations where id = %s", (org_id,))
    finally:
        connection.execute("set session_replication_role = origin")


def _assert_cleanup(connection: psycopg.Connection, org_id: str) -> None:
    """Prove the acceptance left no row behind."""
    remaining: dict[str, int] = {}
    for table, column in (
        ("gateway_captured_prompts", "org_id"),
        ("gateway_requests", "org_id"),
        ("gateway_attempts", "org_id"),
        ("gateway_usage_events", "org_id"),
        ("gateway_aliases", "org_id"),
        ("gateway_grants", "org_id"),
        ("gateway_identities", "org_id"),
        ("models", "owning_org_id"),
        ("api_keys", "org_id"),
        ("organizations", "id"),
    ):
        row = connection.execute(
            f"select count(*) from public.{table} where {column} = %s",
            (org_id,),
        ).fetchone()
        count = int(row[0]) if row is not None else 0
        if count:
            remaining[table] = count
    if remaining:
        msg = f"acceptance rows survived cleanup: {remaining!r}"
        raise AcceptanceError(msg)


def main() -> int:
    """Run the insights suggestions acceptance end to end."""
    worker_url = os.environ.get("GATEWAY_WORKER_URL", "http://gateway-worker:8080").rstrip("/")
    dsn = os.environ["SUPABASE_DB_URL"]

    server = ThreadingHTTPServer(("0.0.0.0", 0), _LoopbackProvider)  # noqa: S104
    Thread(target=server.serve_forever, daemon=True).start()
    advertised = _own_network_address(worker_url)
    base_url = f"http://{advertised}:{server.server_address[1]}/v1"

    org_id = str(uuid.uuid4())
    api_key_id = str(uuid.uuid4())
    raw_key = f"xpl_insight_{uuid.uuid4().hex}"
    fable_model_id = str(uuid.uuid4())
    opus_model_id = str(uuid.uuid4())
    models = (
        # Launch-catalog list prices, micro-USD per million tokens.
        (
            fable_model_id,
            str(uuid.uuid4()),
            "claude-fable-5",
            "loopback-fable",
            10_000_000,
            1_000_000,
            50_000_000,
        ),
        (
            opus_model_id,
            str(uuid.uuid4()),
            "claude-opus-5",
            "loopback-opus",
            5_000_000,
            500_000,
            25_000_000,
        ),
    )

    connection = psycopg.connect(dsn, autocommit=True)
    try:
        _wait_ready(worker_url)
        _seed_rows(
            connection,
            org_id=org_id,
            api_key_id=api_key_id,
            raw_key=raw_key,
            models=models,
            base_url=base_url,
        )
        _wait_for_org_aliases(connection, org_id, ("claude-fable-5", "claude-opus-5"))
        _grant_default_identity(connection, org_id, ("claude-fable-5", "claude-opus-5"))
        client = OpenAI(base_url=f"{worker_url.rstrip('/')}/v1", api_key=raw_key, max_retries=0)
        _probe_aliases(client, ("claude-fable-5", "claude-opus-5"))
        _reset_ledger(connection, org_id)
        _stream_traffic(client)
        _assert_ledger(connection, org_id)
        prompt_sha256 = _assert_lineage(connection, org_id)
        _assert_capture(connection, org_id, prompt_sha256)
        _assert_suggestions(connection, org_id, prompt_sha256)
    finally:
        try:
            _cleanup(connection, org_id=org_id, model_ids=(fable_model_id, opus_model_id))
            _assert_cleanup(connection, org_id)
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
    print("insights suggestions acceptance passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
