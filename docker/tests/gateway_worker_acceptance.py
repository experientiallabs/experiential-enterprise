# Copyright (c) 2026 Experiential Labs. All rights reserved.
# ruff: noqa: INP001 -- executable backend acceptance smoke.

"""Official-client proof for the private gateway worker's /v1 data plane.

Boots against the worker directly (it is cluster-private in every hosted
environment, so this proof runs in the compose lane): liveness and readiness,
one streamed loopback chat completion under a real ``xpl_`` key, exact ledger
rows, a uniform 401 for an unknown key, and complete fixture-row cleanup. The
loopback OpenAI-compatible provider is hosted inside this process; the
worker's own catalog refresher discovers the seeded model row and dispatches
back to it, so no funded provider credential is ever required.
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

import anthropic
import httpx
import psycopg
from openai import APIStatusError, OpenAI
from psycopg.types.json import Jsonb

_EXPECTED_TEXT = "hello world"
_EXPECTED_INPUT_TOKENS = 2
_EXPECTED_OUTPUT_TOKENS = 2
_READY_DEADLINE_SECONDS = 120.0
# Bounded so a denied or stalled auth on a streaming request fails fast with the
# real error instead of blocking on the SSE read until the CI job cap.
_CLIENT_TIMEOUT_SECONDS = 30.0
# The worker's catalog refresher polls every 15s; two cycles plus margin.
_CATALOG_DEADLINE_SECONDS = 90.0


class AcceptanceError(RuntimeError):
    """The gateway worker acceptance observed a contract violation."""


class _LoopbackProvider(BaseHTTPRequestHandler):
    """Serve one finite OpenAI-compatible SSE completion per dispatch."""

    def do_POST(self) -> None:
        """Stream text, usage, and terminal frames for one provider request."""
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length))
        if payload.get("stream") is not True:
            self.send_response(400)
            self.end_headers()
            return
        frames = (
            _frame(
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": "hello "},
                            "finish_reason": None,
                        }
                    ]
                }
            ),
            _frame(
                {"choices": [{"index": 0, "delta": {"content": "world"}, "finish_reason": "stop"}]}
            ),
            _frame({"choices": [], "usage": {"prompt_tokens": 2, "completion_tokens": 2}}),
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
    """Resolve the address the worker can dispatch back to.

    Args:
        worker_url: The gateway worker origin, used only to select the
            outbound interface.

    Returns:
        This container's IP on the shared compose network, or the explicit
        ``EXPLABS_ACCEPTANCE_HOST`` override.
    """
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
    model_id: str,
    provider_row_id: str,
    slug: str,
    base_url: str,
) -> None:
    """Insert the org, key, and loopback model rows the proof rides on."""
    connection.execute(
        "insert into public.organizations (id, slug, name)"
        " values (%s, %s, 'Gateway Worker Acceptance')",
        (org_id, f"gw-accept-{org_id[:13]}"),
    )
    # Deny-by-default (P-B): a key hangs off an identity, and authorization needs a
    # gateway_grants row for that identity and the served alias. Seed the org's
    # default identity exactly as P-A's backfill does (id 'org-' || org_id) and
    # reparent the key onto it; the grant is added once the worker's catalog
    # refresher has created the alias (see _grant_default_identity).
    connection.execute(
        "insert into public.gateway_identities (identity_id, org_id, display_name)"
        " values (%s, %s, 'Default') on conflict (identity_id) do nothing",
        (f"org-{org_id}", org_id),
    )
    connection.execute(
        """
        insert into public.api_keys (id, org_id, name, key_prefix, key_hash, identity_id)
        values (%s, %s, 'gateway-worker-acceptance', %s, %s, %s)
        """,
        (
            api_key_id,
            org_id,
            raw_key[:12],
            hashlib.sha256(raw_key.encode()).hexdigest(),
            f"org-{org_id}",
        ),
    )
    connection.execute(
        "insert into public.models (id, slug, display_name, owning_org_id)"
        " values (%s, %s, 'Gateway Acceptance Loopback', %s)",
        (model_id, slug, org_id),
    )
    connection.execute(
        """
        insert into public.model_providers (
          id, model_id, provider, provider_model_id, base_url, owning_org_id,
          billing_source, capabilities
        ) values (%s, %s, 'local', 'loopback-model', %s, %s, 'customer_managed', %s)
        """,
        (provider_row_id, model_id, base_url, org_id, Jsonb({"supports_streaming": True})),
    )


def _wait_for_alias(connection: psycopg.Connection, slug: str) -> None:
    """Wait for the worker's catalog refresher to CREATE the servable alias row.

    Polls gateway_aliases directly (grant-independent) rather than /v1/models,
    which under deny-by-default (P-B) is grant-filtered: the alias is granted only
    AFTER this returns (the grant FKs the alias_id the refresher creates here), so
    a /v1/models probe would never see the still-ungranted alias. Requires a
    current_revision_id so the alias is fully servable before the grant + stream.
    """
    deadline = time.monotonic() + _CATALOG_DEADLINE_SECONDS
    while time.monotonic() < deadline:
        row = connection.execute(
            """
            select 1 from public.gateway_aliases
             where alias_name = %s and active and current_revision_id is not null
            """,
            (slug,),
        ).fetchone()
        if row is not None:
            return
        time.sleep(3.0)
    msg = f"seeded model {slug!r} never appeared in gateway_aliases before the deadline"
    raise AcceptanceError(msg)


def _assert_alias_listed(worker_url: str, raw_key: str, slug: str) -> None:
    """After the grant, the alias surfaces in the grant-filtered /v1/models.

    Proves granted_aliases (rewritten by P-B) lists exactly the granted alias
    end-to-end through the worker, and that the grant took effect before serving.
    """
    with httpx.Client(base_url=worker_url, timeout=10.0) as client:
        models = client.get("/v1/models", headers={"Authorization": f"Bearer {raw_key}"})
    listed = models.status_code == 200 and slug in [
        item.get("id") for item in models.json().get("data", ())
    ]
    if not listed:
        msg = (
            f"granted model {slug!r} not listed in /v1/models after the grant; "
            f"saw {models.status_code} {models.text[:500]}"
        )
        raise AcceptanceError(msg)


def _grant_default_identity(connection: psycopg.Connection, *, org_id: str, slug: str) -> None:
    """Grant the org's default identity the alias the catalog refresher created.

    Deny-by-default (P-B) authorizes a request only when a gateway_grants row exists
    for (identity_id, alias_id). The worker's catalog refresher builds the org-scoped
    alias from the seeded loopback model; grant the default identity that alias,
    mirroring the (default identity, own-org alias) grant P-A's backfill produces for
    a real org. Runs after _wait_for_alias so the alias row exists.
    """
    granted = connection.execute(
        """
        insert into public.gateway_grants (org_id, identity_id, alias_id)
        select %s, %s, effective.alias_id
          from (
            select aliases.alias_id
              from public.gateway_aliases aliases
             where aliases.alias_name = %s and aliases.active
               and (aliases.org_id is null or aliases.org_id = %s)
             order by (aliases.org_id is not null) desc
             limit 1
          ) effective
        on conflict do nothing
        returning alias_id
        """,
        (org_id, f"org-{org_id}", slug, org_id),
    ).fetchone()
    if granted is None:
        msg = f"no org-scoped alias {slug!r} to grant after catalog refresh"
        raise AcceptanceError(msg)


def _stream_completion(worker_url: str, raw_key: str, slug: str) -> None:
    """Stream one official-client chat completion and verify its content."""
    client = OpenAI(
        base_url=f"{worker_url.rstrip('/')}/v1",
        api_key=raw_key,
        max_retries=0,
        timeout=_CLIENT_TIMEOUT_SECONDS,
    )
    first_chunk_at: float | None = None
    parts: list[str] = []
    stream = client.chat.completions.create(
        model=slug,
        messages=[{"role": "user", "content": "hi"}],
        stream=True,
    )
    for chunk in stream:
        if first_chunk_at is None:
            first_chunk_at = time.monotonic()
        parts.extend(
            choice.delta.content
            for choice in chunk.choices
            if choice.delta and choice.delta.content
        )
    text = "".join(parts)
    if text != _EXPECTED_TEXT:
        msg = f"streamed completion returned {text!r}, expected {_EXPECTED_TEXT!r}"
        raise AcceptanceError(msg)
    if first_chunk_at is None:
        msg = "the completion stream carried no chunks"
        raise AcceptanceError(msg)


def _stream_anthropic_message(worker_url: str, raw_key: str, slug: str) -> None:
    """Stream one official Anthropic-client message through /v1/messages."""
    client = anthropic.Anthropic(
        base_url=worker_url,
        api_key=raw_key,
        max_retries=0,
        timeout=_CLIENT_TIMEOUT_SECONDS,
    )
    parts: list[str] = []
    stop_reason: str | None = None
    stream = client.messages.create(
        model=slug,
        max_tokens=64,
        stream=True,
        messages=[{"role": "user", "content": "hi"}],
    )
    for event in stream:
        if event.type == "content_block_delta" and event.delta.type == "text_delta":
            parts.append(event.delta.text)
        if event.type == "message_delta":
            stop_reason = event.delta.stop_reason
    text = "".join(parts)
    if text != _EXPECTED_TEXT:
        msg = f"anthropic stream returned {text!r}, expected {_EXPECTED_TEXT!r}"
        raise AcceptanceError(msg)
    if stop_reason != "end_turn":
        msg = f"anthropic stream ended with stop_reason {stop_reason!r}, expected 'end_turn'"
        raise AcceptanceError(msg)


def _assert_anthropic_unauthorized(worker_url: str, slug: str) -> None:
    """An unknown key answers 401 in the Anthropic error envelope."""
    client = anthropic.Anthropic(
        base_url=worker_url,
        api_key="xpl_not_a_key",
        max_retries=0,
        timeout=_CLIENT_TIMEOUT_SECONDS,
    )
    try:
        client.messages.create(
            model=slug, max_tokens=8, messages=[{"role": "user", "content": "hi"}]
        )
    except anthropic.APIStatusError as error:
        if error.status_code != 401:
            msg = f"unknown key answered {error.status_code} on /v1/messages, expected 401"
            raise AcceptanceError(msg) from error
        return
    msg = "an unknown xpl_ key was accepted on /v1/messages"
    raise AcceptanceError(msg)


def _assert_uniform_unauthorized(worker_url: str, slug: str) -> None:
    """An unknown key answers 401 with the uniform OpenAI error shape."""
    client = OpenAI(
        base_url=f"{worker_url.rstrip('/')}/v1",
        api_key="xpl_not_a_key",
        max_retries=0,
        timeout=_CLIENT_TIMEOUT_SECONDS,
    )
    try:
        client.chat.completions.create(model=slug, messages=[{"role": "user", "content": "hi"}])
    except APIStatusError as error:
        if error.status_code != 401:
            msg = f"unknown key answered {error.status_code}, expected 401"
            raise AcceptanceError(msg) from error
        return
    msg = "an unknown xpl_ key was accepted"
    raise AcceptanceError(msg)


def _assert_ledger(connection: psycopg.Connection, org_id: str, *, completions: int) -> None:
    """Every completed stream settled one consistent ledger lineage.

    The Anthropic Messages lane is a protocol adapter over the chat dispatch
    path, so its rows are identical to a native call's — api_surface reads
    'chat_completions' for both (the documented v1 tradeoff), which is why one
    expected-row shape multiplied by ``completions`` covers both lanes.
    """
    request_rows = connection.execute(
        "select terminal_state, api_surface from public.gateway_requests where org_id = %s",
        (org_id,),
    ).fetchall()
    if request_rows != [("completed", "chat_completions")] * completions:
        msg = f"gateway_requests rows are {request_rows!r}"
        raise AcceptanceError(msg)
    attempt_rows = connection.execute(
        """
        select state, billing_source, input_tokens, output_tokens
          from public.gateway_attempts where org_id = %s
        """,
        (org_id,),
    ).fetchall()
    expected_attempt = [
        ("completed", "customer_managed", _EXPECTED_INPUT_TOKENS, _EXPECTED_OUTPUT_TOKENS)
    ] * completions
    if attempt_rows != expected_attempt:
        msg = f"gateway_attempts rows are {attempt_rows!r}, expected {expected_attempt!r}"
        raise AcceptanceError(msg)
    usage_rows = connection.execute(
        "select lane, cost_micro_usd, status from public.gateway_usage_events where org_id = %s",
        (org_id,),
    ).fetchall()
    if usage_rows != [("pass_through", 0, "completed")] * completions:
        msg = f"gateway_usage_events rows are {usage_rows!r}"
        raise AcceptanceError(msg)


def _cleanup(
    connection: psycopg.Connection,
    *,
    org_id: str,
    model_id: str,
    slug: str,
) -> None:
    """Remove every seeded and worker-registered row for this run."""
    connection.execute("set session_replication_role = replica")
    try:
        for table in (
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
               select alias_id from public.gateway_aliases where alias_name = %s
             )
            """,
            (slug,),
        ).fetchall()
        connection.execute(
            """
            delete from public.gateway_alias_revisions where alias_id in (
              select alias_id from public.gateway_aliases where alias_name = %s
            )
            """,
            (slug,),
        )
        connection.execute("delete from public.gateway_aliases where alias_name = %s", (slug,))
        for (catalog_sha256,) in snapshot_rows:
            connection.execute(
                "delete from public.gateway_catalog_snapshots where catalog_sha256 = %s",
                (catalog_sha256,),
            )
        connection.execute("delete from public.model_providers where model_id = %s", (model_id,))
        connection.execute("delete from public.models where id = %s", (model_id,))
        connection.execute("delete from public.credit_ledger where org_id = %s", (org_id,))
        connection.execute("delete from public.api_keys where org_id = %s", (org_id,))
        connection.execute("delete from public.gateway_grants where org_id = %s", (org_id,))
        connection.execute("delete from public.gateway_identities where org_id = %s", (org_id,))
        connection.execute("delete from public.organizations where id = %s", (org_id,))
    finally:
        connection.execute("set session_replication_role = origin")


def _assert_cleanup(connection: psycopg.Connection, org_id: str, slug: str) -> None:
    """Prove the acceptance left no row behind."""
    remaining: dict[str, int] = {}
    for table, column, value in (
        ("gateway_requests", "org_id", org_id),
        ("gateway_attempts", "org_id", org_id),
        ("gateway_usage_events", "org_id", org_id),
        ("gateway_grants", "org_id", org_id),
        ("gateway_identities", "org_id", org_id),
        ("gateway_aliases", "alias_name", slug),
        ("api_keys", "org_id", org_id),
        ("organizations", "id", org_id),
        ("models", "slug", slug),
    ):
        row = connection.execute(
            f"select count(*) from public.{table} where {column} = %s",
            (value,),
        ).fetchone()
        count = int(row[0]) if row is not None else 0
        if count:
            remaining[table] = count
    if remaining:
        msg = f"acceptance rows survived cleanup: {remaining!r}"
        raise AcceptanceError(msg)


def main() -> int:
    """Run the gateway worker acceptance end to end."""
    worker_url = os.environ.get("GATEWAY_WORKER_URL", "http://gateway-worker:8080").rstrip("/")
    dsn = os.environ["SUPABASE_DB_URL"]

    server = ThreadingHTTPServer(("0.0.0.0", 0), _LoopbackProvider)  # noqa: S104
    Thread(target=server.serve_forever, daemon=True).start()
    advertised = _own_network_address(worker_url)
    base_url = f"http://{advertised}:{server.server_address[1]}/v1"

    org_id = str(uuid.uuid4())
    api_key_id = str(uuid.uuid4())
    raw_key = f"xpl_accept_{uuid.uuid4().hex}"
    model_id = str(uuid.uuid4())
    provider_row_id = str(uuid.uuid4())
    slug = f"gw-accept-{uuid.uuid4().hex[:8]}"

    connection = psycopg.connect(dsn, autocommit=True)
    try:
        _wait_ready(worker_url)
        _seed_rows(
            connection,
            org_id=org_id,
            api_key_id=api_key_id,
            raw_key=raw_key,
            model_id=model_id,
            provider_row_id=provider_row_id,
            slug=slug,
            base_url=base_url,
        )
        _wait_for_alias(connection, slug)
        _grant_default_identity(connection, org_id=org_id, slug=slug)
        _assert_alias_listed(worker_url, raw_key, slug)
        _stream_completion(worker_url, raw_key, slug)
        _assert_ledger(connection, org_id, completions=1)
        _stream_anthropic_message(worker_url, raw_key, slug)
        _assert_ledger(connection, org_id, completions=2)
        _assert_uniform_unauthorized(worker_url, slug)
        _assert_anthropic_unauthorized(worker_url, slug)
    finally:
        try:
            _cleanup(connection, org_id=org_id, model_id=model_id, slug=slug)
            _assert_cleanup(connection, org_id, slug)
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
    print("gateway worker acceptance passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
