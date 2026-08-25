# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""End-to-end gateway integration suite: the launch's ten-scenario proof.

Every test runs against the real docker-compose Postgres (``SUPABASE_DB_URL``)
with REAL gateway worker processes launched through the installed
``explabs-gateway-worker`` console script, exactly as the hosting platform runs them. The
providers are local HTTP servers speaking the OpenAI-compatible SSE wire
protocol (Experiential's launch-test ``_LoopbackProvider`` pattern) with a scriptable
per-dispatch outcome queue (Experiential's ``_ScriptedProvider`` pattern lifted to the
HTTP layer, so the scripting works across process boundaries).

Lanes under test:

- pass-through (BYOK): org-owned models over ``provider=local`` rows;
- platform-funded: public models over ``provider=modal`` rows, whose schema
  admits a loopback ``base_url`` and whose credential is the ``MODAL_API_KEY``
  worker-environment fallback (doubling as the platform-credential canary).

Real worker processes are the one sanctioned subprocess use in this suite:
scenario 8 kills a worker mid-stream with SIGKILL and scenario 9 restarts the
pool, which no in-process composition can express.

The int-P6 edge repoint has not landed on this stack, so scenarios 1-4 drive
the workers directly (the plan's documented fallback); the edge-inclusive
variants move to int-P6's branch when it exists.

Timing note: wherever host time meets DB ``clock_timestamp()`` the margins
are deliberately generous (multiple seconds), because a CPU-saturated Docker
host stalls the guest clock; a clean full pass wants a non-saturated machine
(CI runners qualify).
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections import Counter, deque
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, LiteralString, cast

import anthropic
import httpx
import psycopg
import pytest
from openai import APIStatusError, OpenAI

if TYPE_CHECKING:
    from openai import Stream
    from openai.types.chat import ChatCompletionChunk

from explabs.gateway.conftest import GatewayHarness, SeededKey

pytestmark = pytest.mark.integration

# One worker pair serves scenarios 1-7 and 10; scenarios 8-9 spawn their own
# short-deadline workers so crash reconciliation stays fast.
_DEFAULT_REQUEST_TIMEOUT_SECONDS = 30
_CRASH_REQUEST_TIMEOUT_SECONDS = 10

# Loopback usage mirrors Experiential's launch test: 2 prompt + 2 completion tokens.
_DEFAULT_PROMPT_TOKENS = 2
_DEFAULT_COMPLETION_TOKENS = 2

# Frozen micro-USD-per-million rates for the fixture deployments.
_DIRECT_INPUT_RATE = 2_500_000
_DIRECT_OUTPUT_RATE = 10_000_000
_HOST_INPUT_RATE = 2_500_000
_HOST_OUTPUT_RATE = 10_000_000
_HOST2_INPUT_RATE = 1_000_000
_HOST2_OUTPUT_RATE = 5_000_000
_CAP_INPUT_RATE = 1_000_000
_CAP_OUTPUT_RATE = 100_000_000  # $100/M output makes the key cap bind fast.
_CAP_COMPLETION_TOKENS = 500  # scripted usage: one answer settles ~$0.05

_HOST_MAX_OUTPUT_TOKENS = 512


def _database_url() -> str:
    """Return the disposable integration database URL or skip the module."""
    value = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not value:
        pytest.skip("SUPABASE_DB_URL is required for the gateway e2e suite")
    return value


def _unused_port() -> int:
    """Reserve one free loopback port."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _cost_micro_usd(
    input_tokens: int,
    output_tokens: int,
    input_rate: int,
    output_rate: int,
) -> int:
    """Mirror ``gateway_attempt_cost_micro_usd``: integer micro-USD, half up."""
    return (input_tokens * input_rate + output_tokens * output_rate + 500_000) // 1_000_000


# -- scripted SSE provider -------------------------------------------------------


@dataclass(frozen=True)
class ProviderOutcome:
    """One scripted physical-dispatch result served over real HTTP.

    ``frames`` is the SSE byte script when ``status`` is 200; a non-200
    ``status`` answers a JSON provider error instead. ``abrupt_close`` drops
    the socket after the scripted frames without a terminal ``[DONE]``.
    """

    frames: tuple[bytes, ...] = ()
    status: int = 200
    frame_delay_seconds: float = 0.0
    abrupt_close: bool = False


def _frame(payload: dict[str, object]) -> bytes:
    """Encode one provider SSE data frame."""
    return b"data: " + json.dumps(payload).encode() + b"\n\n"


def completion_frames(
    text_parts: tuple[str, ...] = ("hello ", "world"),
    *,
    prompt_tokens: int = _DEFAULT_PROMPT_TOKENS,
    completion_tokens: int = _DEFAULT_COMPLETION_TOKENS,
    finish_reason: str = "stop",
    include_usage: bool = True,
    include_done: bool = True,
) -> tuple[bytes, ...]:
    """Build a scripted OpenAI-compatible chat completion SSE stream."""
    frames: list[bytes] = []
    for index, part in enumerate(text_parts):
        delta: dict[str, object] = {"content": part}
        if index == 0:
            delta["role"] = "assistant"
        frames.append(_frame({"choices": [{"index": 0, "delta": delta, "finish_reason": None}]}))
    frames.append(_frame({"choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}]}))
    if include_usage:
        frames.append(
            _frame(
                {
                    "choices": [],
                    "usage": {
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                    },
                }
            )
        )
    if include_done:
        frames.append(b"data: [DONE]\n\n")
    return tuple(frames)


class _ScriptedHandler(BaseHTTPRequestHandler):
    """Serve the owning server's next scripted outcome for one POST."""

    server: ScriptedProviderServer  # narrowed by ScriptedProviderServer

    def do_POST(self) -> None:
        """Record the request and play the next outcome (or the default)."""
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length))
        headers = {name.lower(): value for name, value in self.headers.items()}
        outcome = self.server.record_and_next(payload, headers)
        if outcome.status != 200:
            body = json.dumps(
                {"error": {"message": "scripted provider failure", "type": "server_error"}}
            ).encode()
            self.send_response(outcome.status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for frame in outcome.frames:
            if outcome.frame_delay_seconds:
                time.sleep(outcome.frame_delay_seconds)
            try:
                self.wfile.write(frame)
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
        if outcome.abrupt_close:
            # Drop the socket without a terminal frame: post-commit death.
            self.connection.close()

    def log_message(self, format: str, *args: object) -> None:
        """Suppress request logs so test output cannot retain payload content."""
        del format, args


class ScriptedProviderServer(ThreadingHTTPServer):
    """One loopback OpenAI-compatible provider with a per-dispatch script queue."""

    def __init__(self) -> None:
        """Bind an ephemeral loopback port and start with an empty script."""
        super().__init__(("127.0.0.1", 0), _ScriptedHandler)
        self._lock = threading.Lock()
        self._script: deque[ProviderOutcome] = deque()
        self.payloads: list[dict[str, object]] = []
        self.header_records: list[dict[str, str]] = []
        self._thread = threading.Thread(target=self.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        """The OpenAI-compatible base URL of this provider."""
        return f"http://127.0.0.1:{self.server_address[1]}/v1"

    @property
    def calls(self) -> int:
        """How many physical dispatches this provider has served."""
        with self._lock:
            return len(self.payloads)

    def script(self, *outcomes: ProviderOutcome) -> None:
        """Queue outcomes for the next dispatches (default stream afterwards)."""
        with self._lock:
            self._script.extend(outcomes)

    def record_and_next(
        self, payload: dict[str, object], headers: dict[str, str]
    ) -> ProviderOutcome:
        """Record one dispatch payload and headers, then pop its outcome."""
        with self._lock:
            self.payloads.append(payload)
            self.header_records.append(headers)
            if self._script:
                return self._script.popleft()
        return ProviderOutcome(frames=completion_frames())

    def start(self) -> None:
        """Serve requests on the background thread."""
        self._thread.start()

    def stop(self) -> None:
        """Shut the server down and join its thread."""
        self.shutdown()
        self.server_close()
        self._thread.join(timeout=5)


# -- real worker processes -------------------------------------------------------


class GatewayWorkerProcess:
    """One real gateway worker launched through the installed console script."""

    def __init__(
        self,
        *,
        dsn: str,
        drain_key: str,
        platform_modal_key: str,
        log_dir: Path,
        name: str,
        request_timeout_seconds: int = _DEFAULT_REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        """Prepare one worker's identity, port, environment, and log capture."""
        self.name = name
        self.worker_id = f"e2e-{name}-{uuid.uuid4().hex[:8]}"
        self.port = _unused_port()
        self.log_path = log_dir / f"{self.worker_id}.log"
        self._dsn = dsn
        self._process: subprocess.Popen[bytes] | None = None
        self._env = os.environ | {
            "SUPABASE_DB_URL": dsn,
            "EXPLABS_GATEWAY_WORKER_KEY": drain_key,
            "EXPLABS_GATEWAY_WORKER_ID": self.worker_id,
            "EXPLABS_GATEWAY_WORKER_READY_FILE": str(log_dir / f"{self.worker_id}.ready"),
            "EXPLABS_GATEWAY_WORKER_HEARTBEAT_SECONDS": "1",
            # Reconciliation is invoked explicitly by the scenarios that need
            # it (the SQL function the worker loop calls), keeping every
            # settle deterministic; the loop itself is pinned by worker_test.
            "EXPLABS_GATEWAY_RECONCILE_INTERVAL_SECONDS": "3600",
            "EXPLABS_GATEWAY_RECONCILE_GRACE_SECONDS": "0",
            "EXPLABS_GATEWAY_REQUEST_TIMEOUT_SECONDS": str(request_timeout_seconds),
            "EXPLABS_GATEWAY_DRAIN_TIMEOUT_SECONDS": "45",
            "EXPLABS_APP_VERSION": "e2e-suite",
            "MODAL_API_KEY": platform_modal_key,
        }

    @property
    def base_url(self) -> str:
        """This worker's private HTTP origin."""
        return f"http://127.0.0.1:{self.port}"

    @property
    def pid(self) -> int:
        """The live worker's process id."""
        process = self._process
        assert process is not None, "worker was never started"
        return process.pid

    def start(self) -> None:
        """Launch the console script exactly as the hosting platform app runs it."""
        script = Path(sys.executable).parent / "explabs-gateway-worker"
        log = self.log_path.open("ab")
        self._process = subprocess.Popen(
            [str(script), "--host", "127.0.0.1", "--port", str(self.port)],
            stdout=log,
            stderr=subprocess.STDOUT,
            env=self._env,
        )
        log.close()

    def wait_ready(self, timeout_seconds: float = 90.0) -> None:
        """Poll ``/health/ready`` until the worker admits traffic."""
        deadline = time.monotonic() + timeout_seconds
        last: str = "never connected"
        while time.monotonic() < deadline:
            process = self._process
            if process is not None and process.poll() is not None:
                # Wide enough for a full chained traceback: a 2k tail cuts
                # off the `from exc` cause, hiding the actual failure.
                raise AssertionError(
                    f"worker {self.worker_id} exited during startup: "
                    f"{self.log_path.read_text(errors='replace')[-20_000:]}"
                )
            try:
                response = httpx.get(f"{self.base_url}/health/ready", timeout=2.0)
                if response.status_code == 200:
                    return
                last = response.text
            except httpx.HTTPError as error:
                last = str(error)
            time.sleep(0.2)
        raise AssertionError(f"worker {self.worker_id} never became ready; last: {last}")

    def sigkill(self) -> None:
        """Kill the worker without any grace, as a crash."""
        process = self._process
        assert process is not None
        process.send_signal(signal.SIGKILL)
        process.wait(timeout=10)

    def stop(self) -> None:
        """SIGTERM the worker and wait for its graceful exit."""
        process = self._process
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


# -- fixture seeding on top of the shared harness ---------------------------------


@dataclass
class SeededModel:
    """One seeded model with its deployment identity and provider server."""

    model_id: str
    slug: str
    provider_row_ids: tuple[str, ...]
    exact_model_id: str


class ModelSeeder:
    """Seed and remove Contract 1 catalog rows plus worker-created authority."""

    def __init__(self, connection: psycopg.Connection) -> None:
        """Bind one autocommit connection shared with the harness."""
        self._connection = connection
        self._model_ids: list[str] = []
        self._slugs: list[str] = []
        self._connection_orgs: list[str] = []

    def seed_model(
        self,
        *,
        slug: str,
        owning_org_id: str | None,
        providers: tuple[dict[str, object], ...],
        waterfall: bool = False,
        max_output_tokens: int | None = _HOST_MAX_OUTPUT_TOKENS,
    ) -> SeededModel:
        """Insert one model with its provider rows (and optional waterfall).

        Args:
            slug: The public alias customers place in the ``model`` field.
            owning_org_id: Owning org for a custom model; None = public.
            providers: Per-row overrides: ``provider``, ``base_url``,
                ``billing_source``, ``input_rate``, ``output_rate``.
            waterfall: Whether to chain every provider row as certified rungs.
            max_output_tokens: Output ceiling (the worst-case cost bound).
        """
        model_id = str(uuid.uuid4())
        self._connection.execute(
            """
            insert into public.models (
              id, slug, display_name, owning_org_id, max_output_tokens
            ) values (%s, %s, 'GW e2e', %s, %s)
            """,
            (model_id, slug, owning_org_id, max_output_tokens),
        )
        row_ids: list[str] = []
        for index, spec in enumerate(providers):
            row_id = str(uuid.uuid4())
            row_ids.append(row_id)
            self._connection.execute(
                """
                insert into public.model_providers (
                  id, model_id, provider, provider_model_id, base_url,
                  owning_org_id, billing_source,
                  input_micro_usd_per_million, output_micro_usd_per_million,
                  capabilities, created_at
                ) values (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  '{"supports_streaming": true}'::jsonb,
                  now() + make_interval(secs => %s)
                )
                """,
                (
                    row_id,
                    model_id,
                    spec["provider"],
                    spec.get("provider_model_id", f"e2e-model-{index}"),
                    spec.get("base_url"),
                    spec.get("owning_org_id", owning_org_id),
                    spec["billing_source"],
                    spec.get("input_rate"),
                    spec.get("output_rate"),
                    index,
                ),
            )
        if waterfall:
            for position, row_id in enumerate(row_ids):
                self._connection.execute(
                    """
                    insert into public.model_waterfalls (
                      id, model_id, org_id, position, model_provider_id, updated_at
                    ) values (%s, %s, %s, %s, %s, now())
                    """,
                    (str(uuid.uuid4()), model_id, owning_org_id, position, row_id),
                )
        self._model_ids.append(model_id)
        self._slugs.append(slug)
        return SeededModel(
            model_id=model_id,
            slug=slug,
            provider_row_ids=tuple(row_ids),
            exact_model_id=f"exact-{model_id}",
        )

    def seed_byok_connection(self, org_id: str, provider: str, credential: str) -> None:
        """Store one BYOK credential through the sanctioned Vault path."""
        self._connection.execute(
            "select * from public.upsert_provider_connection(%s, %s, '{}'::jsonb, %s)",
            (org_id, provider, credential),
        )
        self._connection_orgs.append(org_id)

    def cleanup(self, worker_ids: tuple[str, ...]) -> None:
        """Remove models, worker-registered gateway authority, and workers."""
        self._connection.execute("set session_replication_role = replica")
        try:
            for worker_id in worker_ids:
                self._connection.execute(
                    "delete from public.gateway_workers where worker_id = %s", (worker_id,)
                )
            for slug in self._slugs:
                snapshot_rows = self._connection.execute(
                    """
                    select distinct catalog_sha256 from public.gateway_alias_revisions
                     where alias_id in (
                       select alias_id from public.gateway_aliases where alias_name = %s
                     )
                    """,
                    (slug,),
                ).fetchall()
                self._connection.execute(
                    """
                    delete from public.gateway_alias_revisions where alias_id in (
                      select alias_id from public.gateway_aliases where alias_name = %s
                    )
                    """,
                    (slug,),
                )
                self._connection.execute(
                    "delete from public.gateway_aliases where alias_name = %s", (slug,)
                )
                for (catalog_sha256,) in snapshot_rows:
                    self._connection.execute(
                        "delete from public.gateway_catalog_snapshots where catalog_sha256 = %s",
                        (catalog_sha256,),
                    )
            for model_id in self._model_ids:
                self._connection.execute(
                    "delete from public.model_waterfalls where model_id = %s", (model_id,)
                )
                self._connection.execute(
                    "delete from public.model_providers where model_id = %s", (model_id,)
                )
                self._connection.execute("delete from public.models where id = %s", (model_id,))
        finally:
            self._connection.execute("set session_replication_role = origin")


# -- the composed environment ------------------------------------------------------


@dataclass
class E2EEnvironment:
    """Everything the scenarios share: DB access, fixtures, providers, workers."""

    dsn: str
    harness: GatewayHarness
    seeder: ModelSeeder
    log_dir: Path
    drain_key: str
    platform_modal_canary: str
    byok_vault_canary: str
    org_a: str
    org_b: str
    org_drained: str
    user_1: str
    key_a1: SeededKey
    key_a2: SeededKey
    key_b: SeededKey
    key_drained: SeededKey
    providers: dict[str, ScriptedProviderServer]
    models: dict[str, SeededModel]
    workers: list[GatewayWorkerProcess] = field(default_factory=list)
    spawned: list[GatewayWorkerProcess] = field(default_factory=list)
    extra_worker_ids: list[str] = field(default_factory=list)

    @property
    def w1(self) -> GatewayWorkerProcess:
        """The first long-lived worker."""
        return self.workers[0]

    @property
    def w2(self) -> GatewayWorkerProcess:
        """The second long-lived worker."""
        return self.workers[1]

    def spawn_worker(
        self, name: str, *, request_timeout_seconds: int = _DEFAULT_REQUEST_TIMEOUT_SECONDS
    ) -> GatewayWorkerProcess:
        """Launch one additional real worker, tracked for teardown and the sweep."""
        worker = GatewayWorkerProcess(
            dsn=self.dsn,
            drain_key=self.drain_key,
            platform_modal_key=self.platform_modal_canary,
            log_dir=self.log_dir,
            name=name,
            request_timeout_seconds=request_timeout_seconds,
        )
        worker.start()
        self.spawned.append(worker)
        return worker

    def openai_client(self, worker: GatewayWorkerProcess, key: SeededKey) -> OpenAI:
        """Official OpenAI SDK client pointed at one worker's /v1 surface."""
        return OpenAI(api_key=key.raw_key, base_url=f"{worker.base_url}/v1", max_retries=0)

    def fetch_one(
        self, query: LiteralString, params: tuple[object, ...]
    ) -> tuple[object, ...] | None:
        """Read one row on the harness's autocommit session."""
        return self.harness.fetch_one(query, params)

    def fetch_all(
        self, query: LiteralString, params: tuple[object, ...]
    ) -> list[tuple[object, ...]]:
        """Read all rows on the harness's autocommit session."""
        return self.harness.connection.execute(query, params).fetchall()

    def billable_spend(self, org_id: str) -> float:
        """The org's current billable spend in USD."""
        row = self.fetch_one(
            "select billable_spend_usd from public.organizations where id = %s", (org_id,)
        )
        assert row is not None
        return float(str(row[0]))

    def reconcile(self, grace_seconds: int = 0) -> tuple[int, int]:
        """Invoke the sanctioned crash reconciler once, as the worker loop does."""
        row = self.fetch_one(
            "select expired_requests, unknown_attempts"
            " from public.gateway_reconcile_crashed(p_grace_seconds => %s)",
            (grace_seconds,),
        )
        assert row is not None
        return int(str(row[0])), int(str(row[1]))


def _wait_for(
    predicate_name: str,
    check: Callable[[], bool],
    *,
    deadline_seconds: float = 20.0,
    interval_seconds: float = 0.1,
) -> None:
    """Poll one boolean callable until true or fail with its name."""
    deadline = time.monotonic() + deadline_seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(interval_seconds)
    raise AssertionError(f"timed out waiting for {predicate_name}")


@pytest.fixture(scope="module")
def env(tmp_path_factory: pytest.TempPathFactory) -> Iterator[E2EEnvironment]:
    """Seed the full fixture universe, then run two real workers over it."""
    dsn = _database_url()
    suffix = uuid.uuid4().hex[:8]
    log_dir = tmp_path_factory.mktemp("gateway-e2e")
    harness = GatewayHarness(dsn)
    seeder = ModelSeeder(harness.connection)
    providers: dict[str, ScriptedProviderServer] = {
        name: ScriptedProviderServer()
        for name in ("direct", "host", "wf1", "wf2", "cap", "ins", "slow", "shadow")
    }
    for server in providers.values():
        server.start()

    environment: E2EEnvironment | None = None
    try:
        org_a = harness.seed_org()
        org_b = harness.seed_org()
        org_drained = harness.seed_org(drained=True)
        user_1 = str(uuid.uuid4())
        key_a1 = harness.seed_key(org_a, created_by=user_1)
        key_a2 = harness.seed_key(org_a, created_by=user_1)
        key_b = harness.seed_key(org_b)
        key_drained = harness.seed_key(org_drained)

        platform_modal_canary = f"e2e-platform-modal-canary-{suffix}"
        byok_vault_canary = f"e2e-byok-vault-canary-{suffix}"
        drain_key = f"e2e-drain-{suffix}"
        seeder.seed_byok_connection(org_a, "openai", byok_vault_canary)

        def host_row(server: str, **overrides: object) -> dict[str, object]:
            row: dict[str, object] = {
                "provider": "modal",
                "base_url": providers[server].base_url,
                "billing_source": "host_managed",
                "input_rate": _HOST_INPUT_RATE,
                "output_rate": _HOST_OUTPUT_RATE,
            }
            row.update(overrides)
            return row

        models = {
            "direct": seeder.seed_model(
                slug=f"gw9-direct-{suffix}",
                owning_org_id=org_a,
                providers=(
                    {
                        "provider": "local",
                        "base_url": providers["direct"].base_url,
                        "billing_source": "customer_managed",
                        "input_rate": _DIRECT_INPUT_RATE,
                        "output_rate": _DIRECT_OUTPUT_RATE,
                    },
                ),
            ),
            "host": seeder.seed_model(
                slug=f"gw9-host-{suffix}",
                owning_org_id=None,
                providers=(host_row("host"),),
            ),
            "host2": seeder.seed_model(
                slug=f"gw9-host2-{suffix}",
                owning_org_id=None,
                providers=(
                    host_row("host", input_rate=_HOST2_INPUT_RATE, output_rate=_HOST2_OUTPUT_RATE),
                ),
            ),
            "wf": seeder.seed_model(
                slug=f"gw9-wf-{suffix}",
                owning_org_id=None,
                providers=(host_row("wf1"), host_row("wf2")),
                waterfall=True,
            ),
            "cap": seeder.seed_model(
                slug=f"gw9-cap-{suffix}",
                owning_org_id=None,
                providers=(
                    host_row("cap", input_rate=_CAP_INPUT_RATE, output_rate=_CAP_OUTPUT_RATE),
                ),
            ),
            "ins": seeder.seed_model(
                slug=f"gw9-ins-{suffix}",
                owning_org_id=None,
                providers=(host_row("ins"),),
            ),
            "slow": seeder.seed_model(
                slug=f"gw9-slow-{suffix}",
                owning_org_id=None,
                providers=(host_row("slow"),),
            ),
            # One slug in two namespaces: the public row serves the host lane,
            # org B's custom model shadows it for org B's keys only.
            "shadow_public": seeder.seed_model(
                slug=f"gw9-shadow-{suffix}",
                owning_org_id=None,
                providers=(host_row("host"),),
            ),
            "shadow_org_b": seeder.seed_model(
                slug=f"gw9-shadow-{suffix}",
                owning_org_id=org_b,
                providers=(
                    {
                        "provider": "local",
                        "base_url": providers["shadow"].base_url,
                        "billing_source": "customer_managed",
                        "input_rate": _DIRECT_INPUT_RATE,
                        "output_rate": _DIRECT_OUTPUT_RATE,
                    },
                ),
            ),
            # BYOK-canary carrier: releases org A's Vault credential into
            # worker memory without ever being dispatched (it would route to
            # the real provider). Exists for the scenario-10 sweep.
            "byok_canary": seeder.seed_model(
                slug=f"gw9-byokc-{suffix}",
                owning_org_id=org_a,
                providers=(
                    {
                        "provider": "openai",
                        "provider_model_id": "gpt-5",
                        "billing_source": "customer_managed",
                        "input_rate": _DIRECT_INPUT_RATE,
                        "output_rate": _DIRECT_OUTPUT_RATE,
                    },
                ),
            ),
            # The drained org keeps its BYOK lane: zero platform credits must
            # never block pass-through traffic.
            "drained_byok": seeder.seed_model(
                slug=f"gw9-drained-{suffix}",
                owning_org_id=org_drained,
                providers=(
                    {
                        "provider": "local",
                        "base_url": providers["direct"].base_url,
                        "billing_source": "customer_managed",
                        "input_rate": _DIRECT_INPUT_RATE,
                        "output_rate": _DIRECT_OUTPUT_RATE,
                    },
                ),
            ),
        }

        environment = E2EEnvironment(
            dsn=dsn,
            harness=harness,
            seeder=seeder,
            log_dir=log_dir,
            drain_key=drain_key,
            platform_modal_canary=platform_modal_canary,
            byok_vault_canary=byok_vault_canary,
            org_a=org_a,
            org_b=org_b,
            org_drained=org_drained,
            user_1=user_1,
            key_a1=key_a1,
            key_a2=key_a2,
            key_b=key_b,
            key_drained=key_drained,
            providers=providers,
            models=models,
        )
        # Both workers cold-boot CONCURRENTLY, racing to register the same
        # brand-new catalog digest — exactly what the hosting platform does on a rolling
        # deploy. This is the regression proof for int-P1's insert-first fix
        # to gateway_register_catalog_snapshot (8e0508f1); before it, the
        # loser of the check-then-insert race died on the primary key.
        for name in ("w1", "w2"):
            worker = environment.spawn_worker(name)
            environment.workers.append(worker)
        for worker in environment.workers:
            worker.wait_ready()
        # Deny-by-default (P-B): every scenario dispatches through
        # authorize_request, which now requires a gateway_grants row. The workers
        # have registered the catalog, so the base aliases exist; grant each org's
        # default identity the aliases usable under the old rule (public + own-org
        # active), exactly as P-A's backfill does in production. Idempotent;
        # scenarios that activate their own aliases grant them inline.
        harness.connection.execute("select public.gateway_backfill_identity_tier()")
        yield environment
    finally:
        worker_ids: list[str] = []
        if environment is not None:
            for worker in environment.spawned:
                worker_ids.append(worker.worker_id)
                worker.stop()
            worker_ids.extend(environment.extra_worker_ids)
        for server in providers.values():
            server.stop()
        try:
            seeder.cleanup(tuple(worker_ids))
        finally:
            harness.close()


# -- HTTP helpers ------------------------------------------------------------------


def _chat_payload(model: str, prompt: str = "hi", **extra: object) -> dict[str, object]:
    """One minimal chat-completions request body."""
    payload: dict[str, object] = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    }
    payload.update(extra)
    return payload


# Fresh-stack catalog availability budget. A worker can admit traffic while its
# first catalog load is still in progress or while its local generation catches
# up with the DB-authoritative alias revision. The e2e harness absorbs that
# bounded readiness window; an unknown revision after refresh still surfaces.
_WARMUP_TIMEOUT_SECONDS = 30.0
_WARMUP_POLL_SECONDS = 0.5

# Absorbed readiness 503s per alias. An ``unavailable_route`` is a *finished
# request* in the ledger because the routing failure lands after
# ``gateway_accept_request``, so ``gateway_finish_request`` terminalizes it and
# ``gateway_finalize_usage`` counts one request (zero tokens, zero spend) into
# gateway_usage_daily. Rollup assertions therefore have to know how many requests
# the absorbers burned, or a slow runner's readiness window silently
# inflates the alias's request count.
_WARMUP_BURNED_REQUESTS: Counter[str] = Counter()


def _warmup_burn(model: str) -> int:
    """Requests this suite's warmup absorbers finalized for one alias."""
    return _WARMUP_BURNED_REQUESTS[model]


def _is_unavailable_route(body: bytes) -> bool:
    """Whether a response body is the fail-closed ``unavailable_route`` 503."""
    try:
        error = json.loads(body).get("error", {})
    except (json.JSONDecodeError, AttributeError):
        return False
    return isinstance(error, dict) and error.get("code") == "unavailable_route"


def _stream_chat(
    worker: GatewayWorkerProcess,
    key: SeededKey,
    model: str,
    prompt: str = "hi",
    **extra: object,
) -> tuple[str, bool, str]:
    """Stream one chat completion; return (text, saw [DONE], request id).

    Retries the proxied call while the worker is in a bounded
    ``unavailable_route`` readiness window, bounded by
    ``_WARMUP_TIMEOUT_SECONDS``, then asserts a 200 stream.
    """
    text_parts: list[str] = []
    saw_done = False
    request_id = ""
    deadline = time.monotonic() + _WARMUP_TIMEOUT_SECONDS
    with httpx.Client(timeout=60.0) as client:
        while True:
            with client.stream(
                "POST",
                f"{worker.base_url}/v1/chat/completions",
                headers={"Authorization": f"Bearer {key.raw_key}"},
                json=_chat_payload(model, prompt, stream=True, **extra),
            ) as response:
                if (
                    response.status_code == 503
                    and time.monotonic() < deadline
                    and _is_unavailable_route(response.read())
                ):
                    _WARMUP_BURNED_REQUESTS[model] += 1
                    time.sleep(_WARMUP_POLL_SECONDS)
                    continue
                assert response.status_code == 200, response.read().decode()
                request_id = response.headers.get("x-request-id", "")
                for line in response.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line.removeprefix("data: ")
                    if payload == "[DONE]":
                        saw_done = True
                        continue
                    chunk = json.loads(payload)
                    for choice in chunk.get("choices", ()):
                        content = choice.get("delta", {}).get("content")
                        if content:
                            text_parts.append(content)
            break
    return "".join(text_parts), saw_done, request_id


def _post_chat(
    worker: GatewayWorkerProcess,
    key: SeededKey,
    model: str,
    prompt: str = "hi",
    *,
    headers: Mapping[str, str] | None = None,
    **extra: object,
) -> httpx.Response:
    """POST one non-streaming chat completion and return the raw response.

    Retries while the worker is in a bounded ``unavailable_route`` readiness
    window, then returns the response. No scenario intentionally asserts that
    transient response, so this absorbs initial loading and generation
    propagation; an unknown revision still surfaces after the budget.
    """
    merged = {"Authorization": f"Bearer {key.raw_key}"}
    if headers:
        merged.update(headers)
    deadline = time.monotonic() + _WARMUP_TIMEOUT_SECONDS
    while True:
        response = httpx.post(
            f"{worker.base_url}/v1/chat/completions",
            headers=merged,
            json=_chat_payload(model, prompt, **extra),
            timeout=60.0,
        )
        if (
            response.status_code == 503
            and time.monotonic() < deadline
            and _is_unavailable_route(response.content)
        ):
            _WARMUP_BURNED_REQUESTS[model] += 1
            time.sleep(_WARMUP_POLL_SECONDS)
            continue
        return response


# Fail-closed error codes a happy-path SDK call can transiently hit while the
# worker's local generation becomes ready, each self-clearing within the
# warmup budget:
#   - ``unavailable_route`` (503): initial catalog load or local generation
#     catch-up to the DB-authoritative alias revision, same window ``_post_chat``
#     retries.
#   - ``continuation_unavailable`` (400): a just-created continuation is not yet
#     durably visible when the follow-up turn fires (only retried where a VALID
#     previous_response_id is used; the missing-id assertion uses raw httpx, not
#     this wrapper, so its intentional 400 is unaffected).
_TRANSIENT_READINESS_CODES = frozenset({"unavailable_route", "continuation_unavailable"})


def _create_when_ready[T](make_call: Callable[[], T]) -> T:
    """Invoke a NON-STREAMING raw SDK call, absorbing transient readiness windows.

    Only for non-streaming calls: a fail-closed readiness response arrives before
    any dispatch, so re-invoking is side-effect-free. Streamed calls are not
    retried because a failure after dispatch would settle the request twice.

    The worker can fail closed during initial catalog loading, local generation
    catch-up, or continuation propagation. Retry only those transient codes,
    bounded by ``_WARMUP_TIMEOUT_SECONDS``; every other status (auth, quota,
    genuine bad request, replay) surfaces immediately so error-path scenarios
    keep asserting the exact first response. These responses never dispatch, so
    provider call deltas and absolute usage counts stay exact.
    """
    deadline = time.monotonic() + _WARMUP_TIMEOUT_SECONDS
    while True:
        try:
            return make_call()
        except APIStatusError as err:
            # The SDK parses the OpenAI-shaped error body into ``.code``, so this
            # holds for streamed calls too (whose body may already be consumed).
            if err.code not in _TRANSIENT_READINESS_CODES or time.monotonic() >= deadline:
                raise
            time.sleep(_WARMUP_POLL_SECONDS)


def _stream_create_when_ready[T](model: str, make_call: Callable[[], T]) -> T:
    """Invoke a STREAMED raw SDK call, absorbing pre-dispatch readiness 503s.

    Retrying a stream is safe for exactly ``unavailable_route``: it is the
    fail-closed routing response, so it always lands before any provider
    dispatch and re-invoking cannot settle a request twice (the mid-stream
    failures the no-retry rule protects against carry other codes and still
    surface immediately). Unlike ``_create_when_ready``'s codes, each absorbed
    response here is a finished zero-token request in the ledger, so the burn
    counter feeds the alias's rollup assertions.

    Cold boot is the window that needs this: the first scenario's opening call
    races the workers' local generation catch-up, and the seeded catalog keeps
    growing (the 2026-08-23 daily sync added 260 models), so the race that was
    always documented as absorbable now actually loses on CI runners.
    """
    deadline = time.monotonic() + _WARMUP_TIMEOUT_SECONDS
    while True:
        try:
            return make_call()
        except APIStatusError as err:
            if err.code != "unavailable_route" or time.monotonic() >= deadline:
                raise
            _WARMUP_BURNED_REQUESTS[model] += 1
            time.sleep(_WARMUP_POLL_SECONDS)


@dataclass(frozen=True)
class RequestRows:
    """The durable footprint of one request across the three ledger tables."""

    request: tuple[object, ...] | None
    attempts: list[tuple[object, ...]]
    event: tuple[object, ...] | None


def _request_rows(env: E2EEnvironment, request_id: str) -> RequestRows:
    """Load the request, attempts, and usage event for one request id."""
    request = env.fetch_one(
        """
        select terminal_state, api_surface, alias, org_id::text
          from public.gateway_requests where request_id = %s
        """,
        (request_id,),
    )
    attempts = env.fetch_all(
        """
        select attempt_ordinal, route_depth, state, billing_source,
               input_tokens, output_tokens, estimated_cost_micro_usd,
               budget_settled_micro_usd, budget_reserved_micro_usd, failure_class
          from public.gateway_attempts where request_id = %s
         order by attempt_ordinal
        """,
        (request_id,),
    )
    event = env.fetch_one(
        """
        select lane, cost_micro_usd, estimated_cost_micro_usd, status,
               attempt_count, provider, user_id::text, api_key_id::text,
               input_tokens, output_tokens, alias, day
          from public.gateway_usage_events where request_id = %s
        """,
        (request_id,),
    )
    return RequestRows(request=request, attempts=attempts, event=event)


# ==================================================================================
# Scenario 1 — direct alias: one streamed completion, every table consistent.
# ==================================================================================


def test_s1_direct_alias_streams_and_settles_consistently(env: E2EEnvironment) -> None:
    """Xpl key -> streamed completion -> request/attempt/event/rollup all agree."""
    model = env.models["direct"]
    client = env.openai_client(env.w1, env.key_a1)
    parts: list[str] = []
    raw = _stream_create_when_ready(
        model.slug,
        lambda: client.chat.completions.with_raw_response.create(
            model=model.slug,
            messages=[{"role": "user", "content": "hi"}],
            stream=True,
        ),
    )
    request_id = raw.headers.get("x-request-id", "")
    public_id = ""
    chunks = cast("Stream[ChatCompletionChunk]", raw.parse())
    for chunk in chunks:
        public_id = chunk.id or public_id
        if chunk.choices and chunk.choices[0].delta.content:
            parts.append(chunk.choices[0].delta.content)
    assert "".join(parts) == "hello world"
    assert request_id
    assert public_id.startswith("chatcmpl")  # Experiential's stable public id, chatcmpl_<digest>

    expected_cost = _cost_micro_usd(
        _DEFAULT_PROMPT_TOKENS,
        _DEFAULT_COMPLETION_TOKENS,
        _DIRECT_INPUT_RATE,
        _DIRECT_OUTPUT_RATE,
    )
    rows = _request_rows(env, request_id)
    assert rows.request == ("completed", "chat_completions", model.slug, env.org_a)
    attempts = rows.attempts
    assert len(attempts) == 1
    ordinal, depth, state, lane, tokens_in, tokens_out, estimated, settled, _, failure = attempts[0]
    assert (ordinal, depth, state, lane) == (0, 0, "completed", "customer_managed")
    assert (tokens_in, tokens_out) == (_DEFAULT_PROMPT_TOKENS, _DEFAULT_COMPLETION_TOKENS)
    assert estimated == expected_cost
    assert settled == expected_cost  # attributed, never charged
    assert failure is None

    event = rows.event
    assert event is not None
    assert event[0] == "pass_through"
    assert event[1] == 0  # charged money is zero on the BYOK lane
    assert event[2] == expected_cost  # the attributed estimate is split out
    assert event[3] == "completed"
    assert event[4] == 1
    assert event[6] == env.user_1
    assert event[7] == env.key_a1.api_key_id

    daily = env.fetch_one(
        """
        select requests, input_tokens, output_tokens, spend_micro_usd
          from public.gateway_usage_daily
         where org_id = %s and user_id = %s and alias = %s
           and day = (now() at time zone 'UTC')::date
        """,
        (env.org_a, env.user_1, model.slug),
    )
    assert daily is not None
    requests, rollup_in, rollup_out, spend = daily
    # Absorbed readiness 503s are finished zero-token requests in the rollup.
    assert requests == 1 + _warmup_burn(model.slug)
    assert (rollup_in, rollup_out) == (_DEFAULT_PROMPT_TOKENS, _DEFAULT_COMPLETION_TOKENS)
    assert spend == expected_cost


# ==================================================================================
# Scenario 2 — certified waterfall: pre-commit capacity failure advances; a
# committed stream never switches providers.
# ==================================================================================


def test_s2_certified_waterfall_advances_precommit_and_freezes_after_commit(
    env: E2EEnvironment,
) -> None:
    """Deployment 1 fails with capacity -> deployment 2 serves; commit freezes."""
    model = env.models["wf"]
    wf1, wf2 = env.providers["wf1"], env.providers["wf2"]

    # The activated revision carries the synthesized wfcert- certification.
    certification_row = env.fetch_one(
        """
        select revisions.certification
          from public.gateway_aliases aliases
          join public.gateway_alias_revisions revisions
            on revisions.revision_id = aliases.current_revision_id
         where aliases.alias_name = %s and aliases.org_id is null
        """,
        (model.slug,),
    )
    assert certification_row is not None
    raw_certification = certification_row[0]
    assert isinstance(raw_certification, dict)
    certification: dict[str, object] = {str(key): value for key, value in raw_certification.items()}
    assert str(certification["certification_id"]).startswith("wfcert-")
    assert certification["provenance"] == "platform:model_waterfalls"
    order = certification["order"]
    assert isinstance(order, list)
    assert len(order) == 2

    # Committed stream FIRST (rung 1's health state is pristine): rung 1
    # delivers content then dies; the stream must never switch to rung 2
    # after the first content event.
    wf2_calls_before = wf2.calls
    wf1.script(
        ProviderOutcome(
            frames=completion_frames(("committed ",), include_usage=False, include_done=False)[:-1],
            abrupt_close=True,
        )
    )
    with (
        httpx.Client(timeout=60.0) as client,
        client.stream(
            "POST",
            f"{env.w1.base_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {env.key_a1.raw_key}"},
            json=_chat_payload(model.slug, stream=True),
        ) as response,
    ):
        assert response.status_code == 200
        lines = [line for line in response.iter_lines() if line.startswith("data: ")]
    assert any("committed" in line for line in lines)
    assert not any("[DONE]" in line for line in lines) or any("error" in line for line in lines), (
        "a committed stream that lost its provider must not terminate cleanly"
    )
    assert wf2.calls == wf2_calls_before, "committed stream advanced to another provider"
    committed_request = env.fetch_one(
        """
        select requests.request_id, requests.terminal_state
          from public.gateway_requests requests
         where requests.alias = %s and requests.org_id = %s
         order by requests.accepted_at desc limit 1
        """,
        (model.slug, env.org_a),
    )
    assert committed_request is not None
    committed_attempts = env.fetch_all(
        "select route_depth, state from public.gateway_attempts where request_id = %s",
        (str(committed_request[0]),),
    )
    assert len(committed_attempts) == 1
    assert committed_attempts[0][0] == 0

    # Pre-commit capacity error on rung 1 (429: failover-eligible, never
    # retried on the same deployment, and one operational failure below the
    # circuit threshold does not suppress the rung): the pool advances.
    wf1_calls_before = wf1.calls
    wf1.script(ProviderOutcome(status=429))
    text, saw_done, request_id = _stream_chat(env.w1, env.key_a1, model.slug)
    assert text == "hello world"
    assert saw_done
    assert wf1.calls == wf1_calls_before + 1
    assert wf2.calls == wf2_calls_before + 1
    rows = _request_rows(env, request_id)
    assert rows.request is not None
    assert rows.request[0] == "completed"
    attempts = rows.attempts
    assert [(row[0], row[1], row[2]) for row in attempts] == [
        (0, 0, "failed"),
        (1, 1, "completed"),
    ]
    event = rows.event
    assert event is not None
    assert event[4] == 2  # both physical attempts are on the one usage event


# ==================================================================================
# Scenario 3 — streaming Responses and shared cross-worker protocol state.
# ==================================================================================


def test_s3_responses_streaming_and_cross_worker_continuation_and_replay(
    env: E2EEnvironment,
) -> None:
    """previous_response_id works on the SAME and the OTHER worker (int-P2)."""
    model = env.models["direct"]
    env.harness.track_protocol_org(f"org-{env.org_a}")
    provider = env.providers["direct"]

    client_w1 = env.openai_client(env.w1, env.key_a1)
    stream = client_w1.responses.create(model=model.slug, input="first turn", stream=True)
    response_id = ""
    completed = False
    for event in stream:
        if event.type == "response.created":
            response_id = event.response.id
        if event.type == "response.completed":
            completed = True
            response_id = event.response.id
    assert completed
    assert response_id

    # Same-worker continuation.
    calls_before = provider.calls
    follow_same = _create_when_ready(
        lambda: client_w1.responses.create(
            model=model.slug, input="second turn", previous_response_id=response_id
        )
    )
    assert follow_same.id
    assert provider.calls == calls_before + 1
    same_payload = provider.payloads[-1]
    assert "first turn" in json.dumps(same_payload), (
        "the continued request must carry the prior turn to the provider"
    )

    # CROSS-WORKER continuation: the int-P2 shared Postgres continuation store
    # makes this pass on the second worker (launch previously documented a
    # resend error here).
    client_w2 = env.openai_client(env.w2, env.key_a1)
    follow_cross = _create_when_ready(
        lambda: client_w2.responses.create(
            model=model.slug, input="third turn", previous_response_id=follow_same.id
        )
    )
    assert follow_cross.id
    cross_payload = provider.payloads[-1]
    serialized = json.dumps(cross_payload)
    assert "first turn" in serialized
    assert "second turn" in serialized

    # The continuation rows live in the shared table, content-bounded.
    continuation_count = env.fetch_one(
        "select count(*) from public.gateway_continuations where organization_id = %s",
        (f"org-{env.org_a}",),
    )
    assert continuation_count is not None
    assert int(str(continuation_count[0])) >= 2

    # An unknown continuation still fails closed with the documented error.
    bogus = httpx.post(
        f"{env.w2.base_url}/v1/responses",
        headers={"Authorization": f"Bearer {env.key_a1.raw_key}"},
        json={"model": model.slug, "input": "nope", "previous_response_id": "resp_missing"},
        timeout=30.0,
    )
    assert bogus.status_code == 400  # Experiential's continuation_unavailable contract
    assert bogus.json()["error"]["param"] == "previous_response_id"

    # Cross-worker idempotency replay: the exact completed body replays from
    # the shared store; the provider is not dispatched again.
    idempotency_key = f"e2e-replay-{uuid.uuid4().hex[:12]}"
    calls_before = provider.calls
    first = _post_chat(
        env.w1,
        env.key_a1,
        model.slug,
        "replay me",
        headers={"Idempotency-Key": idempotency_key},
    )
    assert first.status_code == 200, first.text
    # The owner publishes its exact result (an awaited lease.complete) before it
    # returns its 200, and both workers share one Postgres, so by the time
    # `first` is observed the shared replay row is already published. A
    # cross-worker replay therefore serves the completed body deterministically:
    # no publish-window race, no re-dispatch. A 409 here would NOT be transient
    # — it only arises when the replay row is reclaimed as a fresh owner, which
    # then trips the request ledger's fail-closed idempotency guard, so retrying
    # would merely spin. That crashed-owner liveness gap is a separate fast-follow.
    replay = _post_chat(
        env.w2,
        env.key_a1,
        model.slug,
        "replay me",
        headers={"Idempotency-Key": idempotency_key},
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["id"] == first.json()["id"]
    assert replay.content == first.content
    assert provider.calls == calls_before + 1, "a replayed request must not re-dispatch"


# ==================================================================================
# Scenario 4 — auth: uniform 401s, org isolation, shadowing, and the dispatch
# shield.
# ==================================================================================


def test_s4_auth_rejections_isolation_and_shadowing(env: E2EEnvironment) -> None:
    """Revoked/expired/unknown keys 401 uniformly; org B alias walls hold."""
    model = env.models["direct"]

    # Valid key serves.
    ok = _post_chat(env.w1, env.key_a1, model.slug)
    assert ok.status_code == 200

    # Unknown key: uniform error body.
    unknown = _post_chat(env.w1, SeededKey(api_key_id="", raw_key="xpl_not_a_key"), model.slug)
    assert unknown.status_code == 401
    unknown_body = unknown.json()["error"]

    # Revoked key answers 401 on the very next request, with the exact same
    # body as an unknown key (no oracle). Inside the 2s authority-reuse window
    # the rejection comes from the folded reservation gate
    # (DispatchKeyRevokedError -> the same boundary 401); outside it, from
    # authorization itself. Either way: strict 401, identical body.
    revoked_key = env.harness.seed_key(env.org_a)
    assert _post_chat(env.w1, revoked_key, model.slug).status_code == 200
    env.harness.connection.execute(
        "update public.api_keys set revoked_at = now() where id = %s",
        (revoked_key.api_key_id,),
    )
    revoked = _post_chat(env.w1, revoked_key, model.slug)
    assert revoked.status_code == 401
    assert revoked.json()["error"] == unknown_body

    # Expired key: same uniform 401.
    expired_key = env.harness.seed_key(
        env.org_a, expires_at=datetime.now(tz=UTC) - timedelta(minutes=1)
    )
    expired = _post_chat(env.w1, expired_key, model.slug)
    assert expired.status_code == 401
    assert expired.json()["error"] == unknown_body

    # Org isolation: org B's key cannot use org A's custom alias, and org A's
    # catalog view never lists org B's custom models.
    cross_org = _post_chat(env.w1, env.key_b, model.slug)
    assert cross_org.status_code == 403
    assert cross_org.json()["error"]["code"] == "model_not_granted"
    models_a = httpx.get(
        f"{env.w1.base_url}/v1/models",
        headers={"Authorization": f"Bearer {env.key_a1.raw_key}"},
        timeout=30.0,
    )
    listed_for_a = {item["id"] for item in models_a.json()["data"]}
    assert model.slug in listed_for_a
    models_b = httpx.get(
        f"{env.w1.base_url}/v1/models",
        headers={"Authorization": f"Bearer {env.key_b.raw_key}"},
        timeout=30.0,
    )
    listed_for_b = {item["id"] for item in models_b.json()["data"]}
    assert model.slug not in listed_for_b
    assert env.models["host"].slug in listed_for_b  # public catalog stays shared

    # Alias shadowing: one slug, two namespaces. Org B's key rides its custom
    # BYOK deployment; org A's key rides the public host-lane deployment.
    shadow_slug = env.models["shadow_public"].slug
    shadow_provider_calls = env.providers["shadow"].calls
    _, _, request_b = _stream_chat(env.w1, env.key_b, shadow_slug)
    assert env.providers["shadow"].calls == shadow_provider_calls + 1
    rows_b = _request_rows(env, request_b)
    assert rows_b.attempts[0][3] == "customer_managed"
    _, _, request_a = _stream_chat(env.w1, env.key_a1, shadow_slug)
    assert env.providers["shadow"].calls == shadow_provider_calls + 1, (
        "org A's request must not touch org B's shadow deployment"
    )
    rows_a = _request_rows(env, request_a)
    assert rows_a.attempts[0][3] == "host_managed"


# ==================================================================================
# Scenario 4b — the DispatchLatchShield over the real SQL gate.
# ==================================================================================


def test_s4_dispatch_time_revocation_terminates_401_and_keeps_readiness(
    env: E2EEnvironment,
) -> None:
    """A key revoked between authorize and dispatch must not poison the worker.

    The race is injected deterministically: an in-process worker app composed
    from the SAME production adapters over the SAME database revokes the key
    inside ``start_attempt`` just before calling int-P1's SQL gate, so the
    real 42501 rejection travels the real shield. The shield's typed
    ``DispatchKeyRevokedError`` (exp #589's ``AttemptRejectedError``) surfaces
    the same uniform 401 as every other revoked-key rejection — never a 500,
    never the old imprecise 429 reshaping; ``/health/ready`` stays 200 and
    other keys keep streaming.
    """
    from typing import cast

    from exp.common.models.gateway_catalog import ExactModelDeployment
    from exp.runtime.gateway.contracts import ExecutionSnapshot
    from exp.runtime.gateway.execution import GatewayExecutor
    from exp.runtime.gateway.interfaces import GatewayClock
    from exp.runtime.gateway.routing import CatalogRouteResolver
    from exp.runtime.gateway.service import GatewayService
    from exp.runtime.gateway.sqlite.store import SystemGatewayClock
    from fastapi.testclient import TestClient

    from explabs.gateway.catalog import GatewayCatalogRefresher, OrgAwareRouteResolver
    from explabs.gateway.control_store import PostgresGatewayControlStore
    from explabs.gateway.db import GatewayDatabase
    from explabs.gateway.ledger import PostgresAttemptLedger
    from explabs.gateway.worker import (
        CrashReconciler,
        DispatchLatchShield,
        GatewayWorkerPhase,
        GatewayWorkerRuntime,
        GatewayWorkerSettings,
        RefreshingGatewayExecutor,
        WorkerPresence,
        catalog_readiness_probe,
        create_gateway_worker_app,
        ping_database,
    )

    racing_key = env.harness.seed_key(env.org_a)
    db = GatewayDatabase(env.dsn, min_size=1, max_size=5)
    clock: GatewayClock = SystemGatewayClock()

    class _RevokeOnDispatchLedger(PostgresAttemptLedger):
        """Revoke one key inside the accept->dispatch window, once."""

        revoke_key_id: str | None = None

        def start_attempt_sync(
            self,
            *,
            snapshot: ExecutionSnapshot,
            deployment: ExactModelDeployment,
            attempt_ordinal: int,
            route_depth: int,
            maximum_cost_micro_usd: int | None = None,
        ) -> str:
            key_id, type(self).revoke_key_id = type(self).revoke_key_id, None
            if key_id is not None:
                env.harness.connection.execute(
                    "update public.api_keys set revoked_at = now() where id = %s",
                    (key_id,),
                )
            return super().start_attempt_sync(
                snapshot=snapshot,
                deployment=deployment,
                attempt_ordinal=attempt_ordinal,
                route_depth=route_depth,
                maximum_cost_micro_usd=maximum_cost_micro_usd,
            )

    ledger = DispatchLatchShield(_RevokeOnDispatchLedger(db, clock=clock))
    # The identical environment (canary included) makes this refresher's build
    # byte-identical to the live workers', so its startup store is a no-op and
    # the real workers never observe a watermark change.
    refresher = GatewayCatalogRefresher(
        lambda: psycopg.connect(env.dsn),
        environment={**os.environ, "MODAL_API_KEY": env.platform_modal_canary},
        poll_interval_seconds=3600.0,
    )
    executor = RefreshingGatewayExecutor(refresher, ledger)
    service = GatewayService(
        control_store=PostgresGatewayControlStore(db, clock=clock),
        ledger=ledger,
        # Production composition's exact casts (see worker.py): the service
        # annotates concrete classes while both adapters match its surface.
        routes=cast("CatalogRouteResolver", OrgAwareRouteResolver(refresher)),
        executor=cast("GatewayExecutor", executor),
        clock=clock,
        readiness_probe=catalog_readiness_probe(refresher, clock),
        request_timeout_seconds=30,
    )
    settings = GatewayWorkerSettings(
        worker_id=f"e2e-shield-{uuid.uuid4().hex[:8]}",
        database_url=env.dsn,
        drain_key=env.drain_key,
        ready_file=str(env.log_dir / "shield.ready"),
        reconcile_interval_seconds=3600,
    )
    env.extra_worker_ids.append(settings.worker_id)
    runtime = GatewayWorkerRuntime(
        settings=settings,
        db=db,
        catalog=refresher,
        executor=executor,
        service=service,
        presence=WorkerPresence(
            db,
            settings,
            phase=lambda: GatewayWorkerPhase.READY,
            catalog_sha256=lambda: None,
        ),
        reconciler=CrashReconciler(db, settings),
        ping=lambda: ping_database(env.dsn),
    )
    app = create_gateway_worker_app(runtime=runtime)
    model = env.models["direct"]
    with TestClient(app) as client:
        assert client.get("/health/ready").status_code == 200

        _RevokeOnDispatchLedger.revoke_key_id = racing_key.api_key_id
        raced = client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {racing_key.raw_key}"},
            json=_chat_payload(model.slug),
        )
        # The precise shape: the typed pre-dispatch rejection maps through the
        # shared boundary to the uniform revoked-key 401 before any provider
        # dispatch, never a 500 and never an accounting latch.
        assert raced.status_code == 401, raced.text
        assert raced.json()["error"]["code"] == "invalid_key"

        assert runtime.executor.accounting_healthy()
        assert client.get("/health/ready").status_code == 200

        follow_up = client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {racing_key.raw_key}"},
            json=_chat_payload(model.slug),
        )
        assert follow_up.status_code == 401  # steady-state revocation is a 401

        healthy = client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {env.key_a1.raw_key}"},
            json=_chat_payload(model.slug),
        )
        assert healthy.status_code == 200


# ==================================================================================
# Scenario 5 — budgets and caps: per-key cap, org/model daily caps (billing's
# P1014/P1015 with their customer copy), host-lane-only rpm, balance gate, and
# the untouched BYOK lane.
# ==================================================================================


def _seed_dispatched_attempt(
    env: E2EEnvironment,
    *,
    api_key: SeededKey,
    org_id: str,
    exact_model_id: str,
    reserved_micro_usd: int,
) -> tuple[str, str]:
    """Reserve one synthetic host-lane attempt through the sanctioned SQL paths."""
    request_id = f"e2e-seed-{uuid.uuid4().hex[:16]}"
    env.harness.connection.execute(
        "select public.gateway_accept_request(%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            request_id,
            org_id,
            api_key.api_key_id,
            "gw9-seed",
            "rev-seed",
            "chat_completions",
            "0" * 64,
            None,
            datetime.now(tz=UTC) + timedelta(hours=1),
        ),
    )
    row = env.harness.connection.execute(
        """
        select attempt_id from public.gateway_start_attempt(
          %s, %s, 0, 0, 'seed-dep', 'seed', %s, 'seed-pool', %s,
          'host_managed', null, null, 1000000, null, 1000000, null, %s
        )
        """,
        (request_id, org_id, exact_model_id, "0" * 64, reserved_micro_usd),
    ).fetchone()
    assert row is not None
    return request_id, str(row[0])


def _release_seeded_attempt(env: E2EEnvironment, attempt_id: str) -> None:
    """Settle one synthetic attempt at zero, releasing its reservation."""
    env.harness.connection.execute(
        """
        select public.gateway_settle_attempt(
          %s, 'failed', 'provider_internal', null, null, null, null, 'unknown', true
        )
        """,
        (attempt_id,),
    )


def _org_spent_today_micro_usd(env: E2EEnvironment, org_id: str) -> int:
    """Billing's charged-or-reserved sum for the org's current UTC day."""
    row = env.fetch_one(
        """
        select coalesce(sum(
            case when attempts.state = 'dispatched'
              then attempts.budget_reserved_micro_usd
              else coalesce(attempts.budget_settled_micro_usd, 0)
            end), 0)
          from public.gateway_attempts attempts
         where attempts.org_id = %s
           and attempts.billing_source = 'host_managed'
           and attempts.budget_period_start = date_trunc(
             'day', now() at time zone 'UTC') at time zone 'UTC'
        """,
        (org_id,),
    )
    assert row is not None
    return int(str(row[0]))


def _start_attempt_sqlstate(
    env: E2EEnvironment,
    *,
    api_key: SeededKey,
    org_id: str,
    exact_model_id: str,
    reserved_micro_usd: int,
) -> tuple[str, str]:
    """Drive the reservation gate directly and return (sqlstate, message)."""
    with pytest.raises(psycopg.errors.DatabaseError) as raised:
        _seed_dispatched_attempt(
            env,
            api_key=api_key,
            org_id=org_id,
            exact_model_id=exact_model_id,
            reserved_micro_usd=reserved_micro_usd,
        )
    error = raised.value
    assert error.sqlstate is not None
    return error.sqlstate, error.diag.message_primary or str(error)


def test_s5_budgets_caps_and_host_lane_only_rate_guard(  # noqa: PLR0915 - one money-gate walkthrough, ordered on purpose
    env: E2EEnvironment,
) -> None:
    """Money gates fire BEFORE dispatch with billing's typed errors and copy."""
    cap_model = env.models["cap"]
    host_model = env.models["host"]
    host2_model = env.models["host2"]
    cap_provider = env.providers["cap"]
    key_cap = env.harness.seed_key(env.org_a)
    key_seed = env.harness.seed_key(env.org_a)
    key_rpm = env.harness.seed_key(env.org_a)
    # The seeding key must never trip the free-credit default per-key cap: an
    # explicit row with a null cap disables the key gate so the ORG and MODEL
    # gates below are the ones that fire.
    env.harness.set_key_limits(
        key_seed.api_key_id, daily_spend_cap_micro_usd=None, requests_per_minute=None
    )

    # --- per-key daily cap: pass until the worst case would exceed, then 429
    # before any provider work.
    env.harness.set_key_limits(
        key_cap.api_key_id, daily_spend_cap_micro_usd=60_000, requests_per_minute=None
    )
    cap_provider.script(
        ProviderOutcome(
            frames=completion_frames(("expensive",), completion_tokens=_CAP_COMPLETION_TOKENS)
        )
    )
    first = _post_chat(env.w1, key_cap, cap_model.slug)
    assert first.status_code == 200, first.text
    calls_after_first = cap_provider.calls
    blocked = _post_chat(env.w1, key_cap, cap_model.slug)
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "insufficient_quota"
    # SEAM GAP (reported upstream): Experiential's executor discards the ledger's
    # rejection reason, so the HTTP body carries only the generic quota
    # message; the self-correcting copy is pinned at the SQL layer below.
    assert cap_provider.calls == calls_after_first, "cap rejection reached the provider"
    key_cap_attempts = env.fetch_one(
        """
        select count(*) from public.gateway_attempts attempts
          join public.gateway_requests requests
            on requests.request_id = attempts.request_id
         where requests.api_key_id = %s
        """,
        (key_cap.api_key_id,),
    )
    assert key_cap_attempts is not None
    assert int(str(key_cap_attempts[0])) == 1  # only the first request dispatched
    sqlstate, message = _start_attempt_sqlstate(
        env,
        api_key=key_cap,
        org_id=env.org_a,
        exact_model_id=cap_model.exact_model_id,
        reserved_micro_usd=60_000,
    )
    assert sqlstate == "P1011"
    assert "key_daily_cap" in message
    assert "raise the cap via the gateway key-limits API" in message

    # --- billing's org daily cap ($50/day, free-credit orgs): P1014 plus the
    # verbatim customer copy from gateway_spend_policy_check.
    env.harness.connection.execute(
        "update public.organizations set credit_granted_usd = 500 where id = %s",
        (env.org_a,),
    )
    # Fill today's org bucket to $50 minus ~2k micro-USD across two synthetic
    # models, so each seed clears the $25/model cap while the next request's
    # (larger) worst case crosses the org line.
    spent_before_seeds = _org_spent_today_micro_usd(env, env.org_a)
    to_reserve = 50_000_000 - spent_before_seeds - 2_000
    assert to_reserve > 0, "earlier scenarios spent the whole org day budget"
    half = to_reserve // 2
    assert half < 25_000_000, "seed halves must stay under the model cap"
    seed_a = _seed_dispatched_attempt(
        env,
        api_key=key_seed,
        org_id=env.org_a,
        exact_model_id="exact-seed-a",
        reserved_micro_usd=half,
    )
    seed_b = _seed_dispatched_attempt(
        env,
        api_key=key_seed,
        org_id=env.org_a,
        exact_model_id="exact-seed-b",
        reserved_micro_usd=to_reserve - half,
    )
    try:
        over_org = _post_chat(env.w1, env.key_a1, host_model.slug)
        assert over_org.status_code == 429
        assert over_org.json()["error"]["code"] == "insufficient_quota"
        sqlstate, message = _start_attempt_sqlstate(
            env,
            api_key=key_seed,
            org_id=env.org_a,
            exact_model_id="exact-seed-c",
            reserved_micro_usd=1_000_000,
        )
        assert sqlstate == "P1014"
        assert message.startswith("org_daily_cap: Free-credit accounts are limited to $50/day")
        assert "resets at 00:00 UTC" in message
        assert "/credits" in message
        policy = env.fetch_one(
            "select allowed, reason_code, message"
            " from public.gateway_spend_policy_check(%s, %s, %s)",
            (env.org_a, "exact-anything", 1_000_000),
        )
        assert policy is not None
        assert policy[0] is False
        assert policy[1] == "org_daily_cap"
    finally:
        _release_seeded_attempt(env, seed_a[1])
        _release_seeded_attempt(env, seed_b[1])
    recovered = _post_chat(env.w1, env.key_a1, host_model.slug)
    assert recovered.status_code == 200, "releasing reservations must lift the org cap"

    # --- billing's model daily cap ($25/day per model): P1015, and switching
    # models keeps the customer going.
    seed_model_cap = _seed_dispatched_attempt(
        env,
        api_key=key_seed,
        org_id=env.org_a,
        exact_model_id=host2_model.exact_model_id,
        # $25 minus 2k micro: the next m_host2 request's worst case (~2.8k)
        # is exactly what crosses the model line.
        reserved_micro_usd=24_998_000,
    )
    try:
        over_model = _post_chat(env.w1, env.key_a1, host2_model.slug)
        assert over_model.status_code == 429
        assert over_model.json()["error"]["code"] == "insufficient_quota"
        sqlstate, message = _start_attempt_sqlstate(
            env,
            api_key=key_seed,
            org_id=env.org_a,
            exact_model_id=host2_model.exact_model_id,
            reserved_micro_usd=1_000_000,
        )
        assert sqlstate == "P1015"
        assert message.startswith(
            "model_daily_cap: Free-credit accounts are limited to $25/day per model"
        )
        assert "No model is forbidden" in message
        other_model = _post_chat(env.w1, env.key_a1, host_model.slug)
        assert other_model.status_code == 200, "another model must keep serving under P1015"
    finally:
        _release_seeded_attempt(env, seed_model_cap[1])

    # --- balance gate: a drained org is 429 on the platform-funded lane with
    # billing's insufficient-credits copy, while its BYOK lane is untouched.
    drained = _post_chat(env.w1, env.key_drained, host_model.slug)
    assert drained.status_code == 429
    assert drained.json()["error"]["code"] == "insufficient_quota"
    policy = env.fetch_one(
        "select allowed, reason_code, message from public.gateway_spend_policy_check(%s, %s, %s)",
        (env.org_drained, "exact-anything", 0),
    )
    assert policy is not None
    assert policy[0] is False
    assert policy[1] == "insufficient_credits"
    assert "out of platform credits" in str(policy[2])
    assert "top-ups start at $5" in str(policy[2])
    byok_ok = _post_chat(env.w1, env.key_drained, env.models["drained_byok"].slug)
    assert byok_ok.status_code == 200, "zero credits must never block the BYOK lane"

    # --- request-rate guard on the platform-funded lane ONLY.
    env.harness.set_key_limits(
        key_rpm.api_key_id, daily_spend_cap_micro_usd=None, requests_per_minute=2
    )
    assert _post_chat(env.w1, key_rpm, host_model.slug).status_code == 200
    assert _post_chat(env.w1, key_rpm, host_model.slug).status_code == 200
    throttled = _post_chat(env.w1, key_rpm, host_model.slug)
    assert throttled.status_code == 429
    sqlstate, message = _start_attempt_sqlstate(
        env,
        api_key=key_rpm,
        org_id=env.org_a,
        exact_model_id=host_model.exact_model_id,
        reserved_micro_usd=1_000,
    )
    assert sqlstate == "P1012"
    assert "key_rate_limit" in message
    assert "BYOK dispatch is never counted or blocked" in message
    for _ in range(3):
        byok = _post_chat(env.w1, key_rpm, env.models["direct"].slug)
        assert byok.status_code == 200, "BYOK traffic must never be rate limited"


# ==================================================================================
# Scenario 6 — zero-completion insurance, all three variants.
# ==================================================================================


def test_s6_zero_completion_insurance(env: E2EEnvironment) -> None:
    """Failed, empty, and truncated platform-funded attempts charge honestly.

    Sub-case order is deliberate: the double-500 case opens the deployment's
    in-process circuit on worker 1 (Experiential's health registry, threshold 2), so it
    runs after the success-shaped cases and the final crash case runs on
    worker 2, whose circuit state is untouched.
    """
    model = env.models["ins"]
    provider = env.providers["ins"]
    balance_before = env.billable_spend(env.org_a)

    # (a) empty completion (0 output tokens): completed, yet charged nothing.
    provider.script(ProviderOutcome(frames=completion_frames(text_parts=(), completion_tokens=0)))
    empty = _post_chat(env.w1, env.key_a1, model.slug)
    assert empty.status_code == 200
    empty_rows = _latest_request(env, model.slug)
    assert empty_rows.attempts[0][2] == "completed"
    assert empty_rows.attempts[0][5] == 0  # output tokens
    assert empty_rows.attempts[0][7] == 0  # settled at zero despite completing
    assert empty_rows.event is not None
    assert empty_rows.event[1] == 0
    assert env.billable_spend(env.org_a) == balance_before

    # (b) delivered-then-truncated (finish_reason=length): charged EXACTLY the
    # delivered output tokens.
    provider.script(
        ProviderOutcome(
            frames=completion_frames(("partial ",), completion_tokens=7, finish_reason="length")
        )
    )
    truncated = _post_chat(env.w1, env.key_a1, model.slug)
    assert truncated.status_code == 200
    truncated_rows = _latest_request(env, model.slug)
    expected = _cost_micro_usd(2, 7, _HOST_INPUT_RATE, _HOST_OUTPUT_RATE)
    assert truncated_rows.attempts[0][2] == "incomplete"
    assert truncated_rows.attempts[0][7] == expected
    assert truncated_rows.event is not None
    assert truncated_rows.event[1] == expected
    assert round((env.billable_spend(env.org_a) - balance_before) * 1_000_000) == expected

    # (c) provider error: settle 0, reservation released, balance unchanged.
    # Two scripted 500s: Experiential retries a 5xx once on the same deployment, so
    # both physical attempts must fail for the request to terminalize.
    provider.script(ProviderOutcome(status=500), ProviderOutcome(status=500))
    failed = _post_chat(env.w1, env.key_a1, model.slug)
    assert failed.status_code == 502
    assert failed.json()["error"]["code"] == "all_routes_failed"
    failed_rows = _latest_request(env, model.slug)
    assert len(failed_rows.attempts) == 2  # dispatch + the one same-route retry
    for attempt in failed_rows.attempts:
        assert attempt[2] == "failed"
        assert attempt[7] == 0  # settled
    assert failed_rows.event is not None
    assert failed_rows.event[0] == "platform_funded"
    assert failed_rows.event[1] == 0
    assert failed_rows.event[4] == 2
    assert round((env.billable_spend(env.org_a) - balance_before) * 1_000_000) == expected

    # (d) delivered-then-DIED (post-commit transport death), on worker 2: the
    # crash variant of insurance settles 0 because the delivered usage never
    # arrived.
    provider.script(
        ProviderOutcome(
            frames=completion_frames(("gone ",), include_usage=False, include_done=False),
            abrupt_close=True,
        )
    )
    with (
        httpx.Client(timeout=60.0) as client,
        client.stream(
            "POST",
            f"{env.w2.base_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {env.key_a1.raw_key}"},
            json=_chat_payload(model.slug, stream=True),
        ) as response,
    ):
        assert response.status_code == 200
        list(response.iter_lines())
    died_rows = _latest_request(env, model.slug)
    assert died_rows.attempts[0][2] in {"failed", "incomplete"}
    assert died_rows.attempts[0][7] == 0
    assert round((env.billable_spend(env.org_a) - balance_before) * 1_000_000) == expected


def _latest_request(env: E2EEnvironment, alias: str) -> RequestRows:
    """Rows for the most recently accepted request on one alias."""
    row = env.fetch_one(
        """
        select request_id from public.gateway_requests
         where alias = %s order by accepted_at desc limit 1
        """,
        (alias,),
    )
    assert row is not None
    return _request_rows(env, str(row[0]))


# ==================================================================================
# Scenario 7 — usage rollups across keys, days, and models, with the
# charged/estimated money split.
# ==================================================================================


def test_s7_usage_rollups_across_keys_days_and_models(  # noqa: PLR0915 - the rollup matrix is one coherent assertion set
    env: E2EEnvironment,
) -> None:
    """One user's two keys sum into per-(user, day, model) rollups exactly."""
    host = env.models["host"]
    host2 = env.models["host2"]
    direct = env.models["direct"]
    today = datetime.now(tz=UTC).date()

    def daily(alias: str, day: object = today) -> tuple[int, int, int, int]:
        row = env.fetch_one(
            """
            select requests, input_tokens, output_tokens, spend_micro_usd
              from public.gateway_usage_daily
             where org_id = %s and user_id = %s and day = %s and alias = %s
            """,
            (env.org_a, env.user_1, day, alias),
        )
        if row is None:
            return (0, 0, 0, 0)
        return (int(str(row[0])), int(str(row[1])), int(str(row[2])), int(str(row[3])))

    before_host = daily(host.slug)
    before_host2 = daily(host2.slug)
    before_direct = daily(direct.slug)
    burn_before = {alias: _warmup_burn(alias) for alias in (host.slug, host2.slug, direct.slug)}

    # The same user through two different keys, two models, both workers.
    _, _, host_req_1 = _stream_chat(env.w1, env.key_a1, host.slug)
    _, _, host_req_2 = _stream_chat(env.w2, env.key_a2, host.slug)
    _, _, host2_req = _stream_chat(env.w1, env.key_a1, host2.slug)
    _, _, direct_req = _stream_chat(env.w2, env.key_a1, direct.slug)

    host_cost = _cost_micro_usd(2, 2, _HOST_INPUT_RATE, _HOST_OUTPUT_RATE)
    host2_cost = _cost_micro_usd(2, 2, _HOST2_INPUT_RATE, _HOST2_OUTPUT_RATE)
    direct_cost = _cost_micro_usd(2, 2, _DIRECT_INPUT_RATE, _DIRECT_OUTPUT_RATE)

    # The charged/estimated split on the events themselves.
    for request_id, lane, charged, estimated in (
        (host_req_1, "platform_funded", host_cost, 0),
        (host_req_2, "platform_funded", host_cost, 0),
        (host2_req, "platform_funded", host2_cost, 0),
        (direct_req, "pass_through", 0, direct_cost),
    ):
        event = _request_rows(env, request_id).event
        assert event is not None
        assert event[0] == lane
        assert event[1] == charged
        assert event[2] == estimated
        assert event[6] == env.user_1

    after_host = daily(host.slug)
    after_host2 = daily(host2.slug)
    after_direct = daily(direct.slug)

    def burned(alias: str) -> int:
        """Warmup 503s this test absorbed for one alias, each a counted request."""
        return _warmup_burn(alias) - burn_before[alias]

    # Request counts carry the absorbed warmup 503s (settled pre-dispatch, so
    # zero tokens and zero spend); the token and money deltas stay exact.
    assert after_host[0] - before_host[0] == 2 + burned(host.slug)  # two keys, one bucket
    assert after_host[1] - before_host[1] == 4
    assert after_host[2] - before_host[2] == 4
    assert after_host[3] - before_host[3] == 2 * host_cost
    assert after_host2[0] - before_host2[0] == 1 + burned(host2.slug)
    assert after_host2[3] - before_host2[3] == host2_cost
    assert after_direct[0] - before_direct[0] == 1 + burned(direct.slug)
    assert after_direct[3] - before_direct[3] == direct_cost  # estimated money rolls up too

    # A prior-day bucket. Day attribution is finalize-owned (terminal_at is
    # clock_timestamp inside the settlement transaction), so a second UTC day
    # cannot be produced through the sanctioned paths inside one test run;
    # this row exercises the multi-day READ shape only and is removed by the
    # module teardown with the rest of the org's rows.
    yesterday = today - timedelta(days=1)
    env.harness.connection.execute("set session_replication_role = replica")
    try:
        env.harness.connection.execute(
            """
            insert into public.gateway_usage_daily (
              org_id, user_id, day, alias, requests, input_tokens, output_tokens,
              spend_micro_usd
            ) values (%s, %s, %s, %s, 3, 6, 6, %s)
            """,
            (env.org_a, env.user_1, yesterday, host.slug, 3 * host_cost),
        )
    finally:
        env.harness.connection.execute("set session_replication_role = origin")

    # The Overview question: one indexed query answers per-user daily spend,
    # tokens, and requests over an all-time range, across keys and models.
    all_time = env.fetch_all(
        """
        select day, sum(requests)::bigint, sum(spend_micro_usd)::bigint
          from public.gateway_usage_daily
         where user_id = %s
         group by day order by day
        """,
        (env.user_1,),
    )
    by_day = {row[0]: (int(str(row[1])), int(str(row[2]))) for row in all_time}
    assert yesterday in by_day
    assert by_day[yesterday][0] == 3
    assert by_day[yesterday][1] == 3 * host_cost
    assert today in by_day
    assert by_day[today][0] >= 4

    # Top models per user: the per-alias grouping the Overview's top-model
    # list needs, answered from the same rollup.
    top_models = env.fetch_all(
        """
        select alias, sum(spend_micro_usd)::bigint
          from public.gateway_usage_daily
         where user_id = %s and day = %s
         group by alias order by 2 desc
        """,
        (env.user_1, today),
    )
    aliases = [str(row[0]) for row in top_models]
    assert host.slug in aliases
    assert host2.slug in aliases


# ==================================================================================
# Scenario 7b — the wire carries billing: usage.cost on completions (JSON and
# the final streaming usage chunk) and the pricing extension on /v1/models.
# ==================================================================================


def test_s7b_responses_carry_billed_cost_and_listing_carries_pricing(
    env: E2EEnvironment,
) -> None:
    """A real worker's /v1 responses report the settled billed cost."""
    host = env.models["host"]
    expected_micro = _cost_micro_usd(
        _DEFAULT_PROMPT_TOKENS,
        _DEFAULT_COMPLETION_TOKENS,
        _HOST_INPUT_RATE,
        _HOST_OUTPUT_RATE,
    )
    expected_cost = expected_micro / 1_000_000

    # Non-streaming platform-funded: usage.cost is the settled charge.
    response = _post_chat(env.w1, env.key_a1, host.slug)
    assert response.status_code == 200, response.text
    usage = response.json()["usage"]
    assert usage["cost"] == expected_cost
    # The OpenAI-defined usage fields are untouched beside the extension.
    assert usage["prompt_tokens"] == _DEFAULT_PROMPT_TOKENS
    assert usage["completion_tokens"] == _DEFAULT_COMPLETION_TOKENS

    # Streaming platform-funded: the final usage chunk carries the same cost.
    stream_cost: float | None = None
    with httpx.Client(timeout=60.0) as client:  # noqa: SIM117 - stream context inside the client
        with client.stream(
            "POST",
            f"{env.w1.base_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {env.key_a1.raw_key}"},
            json=_chat_payload(host.slug, stream=True, stream_options={"include_usage": True}),
        ) as stream:
            assert stream.status_code == 200
            for line in stream.iter_lines():
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                chunk = json.loads(line.removeprefix("data: "))
                chunk_usage = chunk.get("usage")
                if isinstance(chunk_usage, dict):
                    stream_cost = chunk_usage.get("cost")
    assert stream_cost == expected_cost

    # KEYED requests are replay-safe: exp's idempotency contract returns the
    # exact retained bytes (S3 pins replay.content == first.content), so the
    # annotator must skip them — the original carries no cost field either.
    direct = env.models["direct"]
    byok = _post_chat(
        env.w1,
        env.key_a1,
        direct.slug,
        headers={"Idempotency-Key": f"cost-fields-{uuid.uuid4()}"},
    )
    assert byok.status_code == 200, byok.text
    assert "cost" not in byok.json()["usage"]

    # The models listing keeps the OpenAI object shape and adds pricing.
    listing = httpx.get(
        f"{env.w1.base_url}/v1/models",
        headers={"Authorization": f"Bearer {env.key_a1.raw_key}"},
        timeout=30.0,
    )
    assert listing.status_code == 200
    by_id = {entry["id"]: entry for entry in listing.json()["data"]}
    assert by_id[host.slug]["object"] == "model"
    assert by_id[host.slug]["pricing"] == {
        "input_micro_usd_per_million_tokens": _HOST_INPUT_RATE,
        "output_micro_usd_per_million_tokens": _HOST_OUTPUT_RATE,
    }


# ==================================================================================
# Scenario 8 — worker failover: kill mid-stream, reconcile honestly, keep
# serving from the surviving worker.
# ==================================================================================


def test_s8_worker_failover_kill_mid_stream_and_reconcile(  # noqa: PLR0915 - the failover story is one ordered sequence
    env: E2EEnvironment,
) -> None:
    """SIGKILL mid-stream: truncated client, unknown_after_crash, charge 0."""
    model = env.models["slow"]
    provider = env.providers["slow"]
    crash_worker = env.spawn_worker(
        "crash-a", request_timeout_seconds=_CRASH_REQUEST_TIMEOUT_SECONDS
    )
    crash_worker.wait_ready()

    # A sibling booting DURING a live stream must never touch it: the slow
    # stream runs on crash_worker while the survivor's whole startup happens
    # (its boot path is the one Experiential per-boot reconciler deliberately NOT
    # taken).
    provider.script(
        ProviderOutcome(
            frames=completion_frames(("tick ",) * 12, completion_tokens=12),
            frame_delay_seconds=0.6,
        )
    )
    live_result: list[tuple[str, bool, str]] = []
    calls_before_live = provider.calls

    def run_live_stream() -> None:
        live_result.append(_stream_chat(crash_worker, env.key_a1, model.slug))

    live_thread = threading.Thread(target=run_live_stream)
    live_thread.start()
    _wait_for(
        "the live stream to reach the provider",
        lambda: provider.calls > calls_before_live,
    )
    survivor = env.spawn_worker("crash-b", request_timeout_seconds=_CRASH_REQUEST_TIMEOUT_SECONDS)
    survivor.wait_ready()
    live_thread.join(timeout=30)
    assert not live_thread.is_alive()
    text, saw_done, live_request = live_result[0]
    assert text == "tick " * 12
    assert saw_done
    live_rows = _request_rows(env, live_request)
    assert live_rows.request is not None
    assert live_rows.request[0] == "completed", (
        "a booting sibling corrupted a live attempt (per-boot reconcile leak)"
    )

    # Kill crash_worker mid-stream on the platform-funded lane.
    balance_before = env.billable_spend(env.org_a)
    provider.script(
        ProviderOutcome(
            frames=completion_frames(("doomed ",) * 40, completion_tokens=40),
            frame_delay_seconds=0.5,
        )
    )
    request_id = ""
    truncated = False
    accepted_at = time.monotonic()
    try:
        with (
            httpx.Client(timeout=30.0) as client,
            client.stream(
                "POST",
                f"{crash_worker.base_url}/v1/chat/completions",
                headers={"Authorization": f"Bearer {env.key_a1.raw_key}"},
                json=_chat_payload(model.slug, stream=True),
            ) as response,
        ):
            assert response.status_code == 200
            request_id = response.headers.get("x-request-id", "")
            for line in response.iter_lines():
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                chunk = json.loads(line.removeprefix("data: "))
                if chunk.get("choices"):
                    # Kill mid-stream; keep reading so the break is observed.
                    crash_worker.sigkill()
    except (httpx.HTTPError, httpx.StreamError):
        truncated = True
    assert truncated, "the client must observe the truncated stream"
    assert request_id, "at least one content chunk must have arrived"

    # Before the request deadline passes, the reconciler must NOT touch the
    # orphan (the grace contract). Guarded by elapsed time: on a saturated
    # host the kill-and-read above can itself consume the deadline, and this
    # sub-assert is only meaningful while the deadline is clearly ahead.
    env.reconcile(grace_seconds=0)
    if time.monotonic() - accepted_at < _CRASH_REQUEST_TIMEOUT_SECONDS - 2.0:
        orphan_state = env.fetch_one(
            "select state from public.gateway_attempts where request_id = %s",
            (request_id,),
        )
        assert orphan_state == ("dispatched",)

    # The surviving worker serves immediately, before any reconciliation.
    served_text, served_done, _ = _stream_chat(survivor, env.key_a1, model.slug)
    assert served_text == "hello world"
    assert served_done

    # After deadline + grace, one reconcile pass settles the orphan honestly.
    elapsed = time.monotonic() - accepted_at
    # Host-clock-to-DB-clock margin: under Docker CPU saturation the guest
    # clock stalls (int-P4's diagnosis of the int-P2 deadline flake), so the
    # margin stays well above the sub-second truth.
    remaining = _CRASH_REQUEST_TIMEOUT_SECONDS + 3.0 - elapsed
    if remaining > 0:
        time.sleep(remaining)
    _, unknown = env.reconcile(grace_seconds=0)
    assert unknown >= 1
    rows = _request_rows(env, request_id)
    assert rows.request is not None
    assert rows.request[0] == "unknown_after_crash"
    assert rows.attempts[0][2] == "unknown_after_crash"
    assert rows.attempts[0][7] == 0  # platform-funded crash charge is zero
    assert rows.event is not None
    assert rows.event[1] == 0
    # The only billable movement since the snapshot is the survivor's one
    # SUCCESSFUL request above; the crashed stream itself charged nothing.
    survivor_cost = _cost_micro_usd(
        _DEFAULT_PROMPT_TOKENS, _DEFAULT_COMPLETION_TOKENS, _HOST_INPUT_RATE, _HOST_OUTPUT_RATE
    )
    assert round((env.billable_spend(env.org_a) - balance_before) * 1_000_000) == survivor_cost

    survivor.stop()


# ==================================================================================
# Scenario 9 — restart recovery: reconcile settles orphans exactly once and
# re-running changes nothing.
# ==================================================================================


def test_s9_restart_recovery_reconciles_exactly_once(  # noqa: C901 - one restart narrative
    env: E2EEnvironment,
) -> None:
    """Restart the pool with streams in flight; reconciliation is idempotent."""
    model = env.models["slow"]
    provider = env.providers["slow"]
    doomed = env.spawn_worker("restart-a", request_timeout_seconds=_CRASH_REQUEST_TIMEOUT_SECONDS)
    doomed.wait_ready()

    provider.script(
        ProviderOutcome(
            frames=completion_frames(("orphan ",) * 40, completion_tokens=40),
            frame_delay_seconds=0.5,
        ),
        ProviderOutcome(
            frames=completion_frames(("orphan ",) * 40, completion_tokens=40),
            frame_delay_seconds=0.5,
        ),
    )

    request_ids: list[str] = []
    request_ids_lock = threading.Lock()

    def open_stream() -> None:
        try:
            with (
                httpx.Client(timeout=30.0) as client,
                client.stream(
                    "POST",
                    f"{doomed.base_url}/v1/chat/completions",
                    headers={"Authorization": f"Bearer {env.key_a1.raw_key}"},
                    json=_chat_payload(model.slug, stream=True),
                ) as response,
            ):
                request_id = response.headers.get("x-request-id", "")
                if request_id:
                    with request_ids_lock:
                        request_ids.append(request_id)
                for _line in response.iter_lines():
                    pass
        except httpx.HTTPError:
            pass

    threads = [threading.Thread(target=open_stream) for _ in range(2)]
    started_at = time.monotonic()
    for thread in threads:
        thread.start()
    _wait_for("both streams to open", lambda: len(request_ids) == 2, deadline_seconds=15)
    doomed.sigkill()
    for thread in threads:
        thread.join(timeout=10)

    # Restart the pool: two fresh workers boot over the orphaned rows and, by
    # contract, do NOT reconcile at boot.
    restarted = [
        env.spawn_worker("restart-b", request_timeout_seconds=_CRASH_REQUEST_TIMEOUT_SECONDS),
        env.spawn_worker("restart-c", request_timeout_seconds=_CRASH_REQUEST_TIMEOUT_SECONDS),
    ]
    for worker in restarted:
        worker.wait_ready()
    states = env.fetch_all(
        "select state from public.gateway_attempts where request_id = any(%s)",
        (request_ids,),
    )
    assert [row[0] for row in states] == ["dispatched", "dispatched"], (
        "a restarting worker reconciled at boot"
    )

    # One explicit reconcile pass settles every orphan exactly once.
    elapsed = time.monotonic() - started_at
    # Same generous host-vs-DB clock margin as scenario 8.
    remaining = _CRASH_REQUEST_TIMEOUT_SECONDS + 3.0 - elapsed
    if remaining > 0:
        time.sleep(remaining)
    _, unknown = env.reconcile(grace_seconds=0)
    assert unknown >= 2
    snapshot = env.fetch_all(
        """
        select attempts.attempt_id, attempts.state, attempts.terminal_at,
               attempts.budget_settled_micro_usd, requests.terminal_state
          from public.gateway_attempts attempts
          join public.gateway_requests requests
            on requests.request_id = attempts.request_id
         where attempts.request_id = any(%s)
         order by attempts.attempt_id
        """,
        (request_ids,),
    )
    assert all(row[1] == "unknown_after_crash" for row in snapshot)
    assert all(row[3] == 0 for row in snapshot)
    assert all(row[4] == "unknown_after_crash" for row in snapshot)
    for request_id in request_ids:
        events = env.fetch_all(
            "select count(*) from public.gateway_usage_events where request_id = %s",
            (request_id,),
        )
        assert int(str(events[0][0])) == 1, "reconcile emitted duplicate usage events"

    # Idempotence: a second pass finds nothing and changes nothing.
    again_expired, again_unknown = env.reconcile(grace_seconds=0)
    assert (again_expired, again_unknown) == (0, 0)
    assert (
        env.fetch_all(
            """
            select attempts.attempt_id, attempts.state, attempts.terminal_at,
                   attempts.budget_settled_micro_usd, requests.terminal_state
              from public.gateway_attempts attempts
              join public.gateway_requests requests
                on requests.request_id = attempts.request_id
             where attempts.request_id = any(%s)
             order by attempts.attempt_id
            """,
            (request_ids,),
        )
        == snapshot
    )
    for worker in restarted:
        worker.stop()


# ==================================================================================
# Scenario 9b — the Anthropic Messages lane: official SDK, tool use, ledger truth.
# ==================================================================================


def _tool_call_frames() -> tuple[bytes, ...]:
    """Script one provider stream that answers with a single tool call."""
    return (
        _frame({"choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]}),
        _frame(
            {
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call_e2e_1",
                                    "type": "function",
                                    "function": {"name": "bash", "arguments": ""},
                                }
                            ]
                        },
                        "finish_reason": None,
                    }
                ]
            }
        ),
        _frame(
            {
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [{"index": 0, "function": {"arguments": '{"cmd": "ls"}'}}]
                        },
                        "finish_reason": None,
                    }
                ]
            }
        ),
        _frame({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}),
        _frame(
            {
                "choices": [],
                "usage": {
                    "prompt_tokens": _DEFAULT_PROMPT_TOKENS,
                    "completion_tokens": _DEFAULT_COMPLETION_TOKENS,
                },
            }
        ),
        b"data: [DONE]\n\n",
    )


def test_s9b_anthropic_messages_lane_end_to_end(env: E2EEnvironment) -> None:
    """Official Anthropic SDK -> /v1/messages -> chat surface -> settled ledger."""
    model = env.models["direct"]
    provider = env.providers["direct"]

    # Absorb the cold-route warmup on the OpenAI lane so the SDK calls below
    # (max_retries=0) never see the 503 window.
    warm = _post_chat(env.w1, env.key_a1, model.slug)
    assert warm.status_code == 200

    client = anthropic.Anthropic(
        base_url=env.w1.base_url, api_key=env.key_a1.raw_key, max_retries=0
    )

    # Non-streaming, authenticated the Anthropic way (x-api-key).
    raw = client.messages.with_raw_response.create(
        model=model.slug,
        max_tokens=64,
        system="Be brief.",
        messages=[{"role": "user", "content": "hi"}],
    )
    request_id = raw.headers.get("x-request-id", "")
    message = raw.parse()
    assert isinstance(message, anthropic.types.Message)
    assert message.role == "assistant"
    text_blocks = [
        block for block in message.content if isinstance(block, anthropic.types.TextBlock)
    ]
    assert [block.text for block in text_blocks] == ["hello world"]
    assert message.stop_reason == "end_turn"
    assert message.usage.input_tokens == _DEFAULT_PROMPT_TOKENS
    assert message.usage.output_tokens == _DEFAULT_COMPLETION_TOKENS
    # The translated body reached the provider with the system prompt intact.
    assert "Be brief." in json.dumps(provider.payloads[-1])

    # The lane is a protocol adapter over the one chat dispatch path, so the
    # ledger deliberately records api_surface as chat_completions and settles
    # the same rows a native OpenAI call would.
    assert request_id
    rows = _request_rows(env, request_id)
    assert rows.request is not None
    assert rows.request[0] == "completed"
    assert rows.request[1] == "chat_completions"
    assert rows.request[2] == model.slug
    assert rows.event is not None

    # Streaming with Bearer auth (the ANTHROPIC_AUTH_TOKEN path) and a
    # scripted tool-call stream: the full Anthropic event grammar comes out.
    provider.script(ProviderOutcome(frames=_tool_call_frames()))
    bearer_client = anthropic.Anthropic(
        base_url=env.w1.base_url, auth_token=env.key_a1.raw_key, max_retries=0
    )
    stream = bearer_client.messages.create(
        model=model.slug,
        max_tokens=64,
        stream=True,
        tools=[
            {"name": "bash", "description": "Run a command", "input_schema": {"type": "object"}}
        ],
        messages=[{"role": "user", "content": "list files"}],
    )
    names: list[str] = []
    tool_name = ""
    tool_json = ""
    stop_reason = None
    output_tokens = 0
    for event in stream:
        names.append(event.type)
        if event.type == "content_block_start" and event.content_block.type == "tool_use":
            tool_name = event.content_block.name
        if event.type == "content_block_delta" and event.delta.type == "input_json_delta":
            tool_json += event.delta.partial_json
        if event.type == "message_delta":
            stop_reason = event.delta.stop_reason
            output_tokens = event.usage.output_tokens
    assert names[0] == "message_start"
    assert names[-1] == "message_stop"
    assert tool_name == "bash"
    assert json.loads(tool_json) == {"cmd": "ls"}
    assert stop_reason == "tool_use"
    assert output_tokens == _DEFAULT_COMPLETION_TOKENS

    # Failures wear the Anthropic envelope end to end: the official SDK
    # raises its own typed error for the uniform 401.
    with pytest.raises(anthropic.AuthenticationError):
        anthropic.Anthropic(
            base_url=env.w1.base_url, api_key="xpl_wrong", max_retries=0
        ).messages.create(
            model=model.slug, max_tokens=8, messages=[{"role": "user", "content": "hi"}]
        )


# ==================================================================================
# Scenario 10 — secret safety: after the whole suite, no canary anywhere.
# ==================================================================================


def test_s10_secret_canaries_never_persist_anywhere(env: E2EEnvironment) -> None:
    """Credentials live in worker memory only: tables, snapshots, logs clean."""
    canaries = (
        env.platform_modal_canary,
        env.byok_vault_canary,
        env.drain_key,
        env.key_a1.raw_key,
        env.key_a2.raw_key,
        env.key_b.raw_key,
    )

    # Prove the platform canary was LIVE (it authenticated real host-lane
    # dispatches) so the sweep below is meaningful.
    host_headers = env.providers["host"].header_records
    assert any(
        env.platform_modal_canary in headers.get("authorization", "") for headers in host_headers
    ), "the host lane never used the platform credential; the sweep proves nothing"

    tables: tuple[LiteralString, ...] = (
        "gateway_requests",
        "gateway_attempts",
        "gateway_usage_events",
        "gateway_usage_daily",
        "gateway_catalog_snapshots",
        "gateway_aliases",
        "gateway_alias_revisions",
        "gateway_key_limits",
        "gateway_workers",
        "gateway_replay_operations",
        "gateway_continuations",
        "models",
        "model_providers",
        "model_waterfalls",
        "provider_connections",
        "credit_ledger",
    )
    for table in tables:
        for canary in canaries:
            row = env.fetch_one(
                f"select count(*) from public.{table} entity where entity::text like %s",
                (f"%{canary}%",),
            )
            assert row is not None
            assert int(str(row[0])) == 0, f"canary persisted in {table}"

    # Every worker's captured stdout/stderr, including the SIGKILLed ones.
    for worker in env.spawned:
        if not worker.log_path.exists():
            continue
        log_text = worker.log_path.read_text(errors="replace")
        for canary in canaries:
            assert canary not in log_text, f"canary leaked into {worker.log_path.name}"


# ==================================================================================
# Scenario 11 — cost controls added by the cost-optimization packet: per-key TPM
# (P1022, trailing settled-token window), per-key and per-model monthly budgets
# (P1023/P1024), and recurring ('*') budget periods. Same shape as scenario 5:
# every refusal is proven at the HTTP surface (429 insufficient_quota, provider
# untouched) AND pinned at the SQL seam with its typed SQLSTATE and copy.
# ==================================================================================


def _start_attempt_sqlstate_on_revision(
    env: E2EEnvironment,
    *,
    api_key: SeededKey,
    org_id: str,
    alias_name: str,
    revision_id: str,
    reserved_micro_usd: int,
) -> tuple[str, str]:
    """Drive the reservation gate for a request on a REAL alias revision.

    The generic ``_start_attempt_sqlstate`` accepts against the synthetic
    ``rev-seed`` revision, which resolves no alias — fine for key/identity
    scopes, invisible to model/pool scopes. Model-budget assertions need the
    request frozen to the alias's live revision.
    """
    request_id = f"e2e-seed-{uuid.uuid4().hex[:16]}"
    env.harness.connection.execute(
        "select public.gateway_accept_request(%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            request_id,
            org_id,
            api_key.api_key_id,
            alias_name,
            revision_id,
            "chat_completions",
            "0" * 64,
            None,
            datetime.now(tz=UTC) + timedelta(hours=1),
        ),
    )
    with pytest.raises(psycopg.errors.DatabaseError) as raised:
        env.harness.connection.execute(
            """
            select attempt_id from public.gateway_start_attempt(
              %s, %s, 0, 0, 'seed-dep', 'seed', 'exact-seed-model', 'seed-pool', %s,
              'host_managed', null, null, 1000000, null, 1000000, null, %s
            )
            """,
            (request_id, org_id, "0" * 64, reserved_micro_usd),
        ).fetchone()
    error = raised.value
    assert error.sqlstate is not None
    return error.sqlstate, error.diag.message_primary or str(error)


def test_s11_tpm_and_key_model_recurring_budgets(  # noqa: PLR0915 - one cost-controls walkthrough, ordered on purpose
    env: E2EEnvironment,
) -> None:
    """TPM and the key/model/recurring budget scopes gate before dispatch."""
    host_model = env.models["host"]
    host2_model = env.models["host2"]
    current_period = datetime.now(tz=UTC).strftime("%Y-%m")

    # --- TPM (P1022): trailing observation over settled tokens. With a
    # 1-token/minute limit, the first request lands (empty window) and its
    # settled usage throttles the second before any provider work.
    key_tpm = env.harness.seed_key(env.org_a)
    env.harness.set_key_limits(
        key_tpm.api_key_id,
        daily_spend_cap_micro_usd=None,
        requests_per_minute=None,
        tokens_per_minute=1,
    )
    first = _post_chat(env.w1, key_tpm, host_model.slug)
    assert first.status_code == 200, first.text
    host_provider_calls = env.providers["host"].calls
    throttled = _post_chat(env.w1, key_tpm, host_model.slug)
    assert throttled.status_code == 429
    assert throttled.json()["error"]["code"] == "insufficient_quota"
    assert env.providers["host"].calls == host_provider_calls, "TPM rejection reached the provider"
    sqlstate, message = _start_attempt_sqlstate(
        env,
        api_key=key_tpm,
        org_id=env.org_a,
        exact_model_id=host_model.exact_model_id,
        reserved_micro_usd=1_000,
    )
    assert sqlstate == "P1022"
    assert "key_token_rate_limit" in message
    assert "tokens-per-minute" in message
    # BYOK dispatch is never token-gated: the same exhausted key keeps
    # streaming on the pass-through lane.
    byok_ok = _post_chat(env.w1, key_tpm, env.models["direct"].slug)
    assert byok_ok.status_code == 200, "TPM must never touch the BYOK lane"

    # --- Per-key budget (P1023), RECURRING ('*') period: the limit governs
    # this month and every month after it, and deleting the row restores
    # service (absence of a row = unlimited).
    key_bud = env.harness.seed_key(env.org_a)
    env.harness.set_key_limits(
        key_bud.api_key_id, daily_spend_cap_micro_usd=None, requests_per_minute=None
    )
    key_budget_id = env.harness.set_budget(
        env.org_a,
        period="*",
        scope_kind="key",
        api_key_id=key_bud.api_key_id,
        # Far below any real request's worst case, so the very first dispatch
        # is refused at the seam.
        limit_micro_usd=1_000,
    )
    over_key = _post_chat(env.w1, key_bud, host_model.slug)
    assert over_key.status_code == 429
    assert over_key.json()["error"]["code"] == "insufficient_quota"
    sqlstate, message = _start_attempt_sqlstate(
        env,
        api_key=key_bud,
        org_id=env.org_a,
        exact_model_id=host_model.exact_model_id,
        reserved_micro_usd=2_000,
    )
    assert sqlstate == "P1023"
    assert "budget_key" in message
    assert "recurring monthly budget" in message
    env.harness.connection.execute(
        "delete from public.gateway_budgets where budget_id = %s", (key_budget_id,)
    )
    restored = _post_chat(env.w1, key_bud, host_model.slug)
    assert restored.status_code == 200, "removing the key budget must restore service"

    # --- Per-model budget (P1024): the alias is capped across every route
    # under it, other models keep serving, and the customer's own other keys
    # are equally bound (the scope is the model, not the caller).
    alias_row = env.fetch_one(
        "select alias_id, current_revision_id from public.gateway_aliases"
        " where alias_name = %s and org_id is null",
        (host2_model.slug,),
    )
    if alias_row is None:
        alias_row = env.fetch_one(
            "select alias_id, current_revision_id from public.gateway_aliases"
            " where alias_name = %s",
            (host2_model.slug,),
        )
    assert alias_row is not None, "host2 alias must exist once the catalog refreshed"
    host2_alias_id, host2_revision_id = str(alias_row[0]), str(alias_row[1])
    model_budget_id = env.harness.set_budget(
        env.org_a,
        period=current_period,
        scope_kind="model",
        alias_id=host2_alias_id,
        limit_micro_usd=1_000,
    )
    try:
        over_model = _post_chat(env.w1, env.key_a1, host2_model.slug)
        assert over_model.status_code == 429
        assert over_model.json()["error"]["code"] == "insufficient_quota"
        sqlstate, message = _start_attempt_sqlstate_on_revision(
            env,
            api_key=env.key_a1,
            org_id=env.org_a,
            alias_name=host2_model.slug,
            revision_id=host2_revision_id,
            reserved_micro_usd=2_000,
        )
        assert sqlstate == "P1024"
        assert "budget_model" in message
        assert f"model {host2_alias_id}" in message
        other_model = _post_chat(env.w1, env.key_a1, host_model.slug)
        assert other_model.status_code == 200, "a model budget must not touch other models"
    finally:
        env.harness.connection.execute(
            "delete from public.gateway_budgets where budget_id = %s", (model_budget_id,)
        )
    lifted = _post_chat(env.w1, env.key_a1, host2_model.slug)
    assert lifted.status_code == 200, "removing the model budget must restore the alias"
