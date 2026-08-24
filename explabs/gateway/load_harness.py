# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Gateway load/latency harness: deterministic upstream, typed reports.

The roadmap's benchmark condition is "identical hardware; every gateway
pointed at the same deterministic mock upstream; single client". This module
is that condition as code, asyncio + httpx with no external load tool (the
only process fan-out is stdlib ``multiprocessing``, and only because one
client process cannot honestly drive high concurrency — see below):

* ``LoopbackProvider`` — an in-process OpenAI-compatible SSE upstream served
  by uvicorn on a loopback port: constant frames, constant token counts,
  optional fixed inter-frame delay, a dispatch counter, and NO payload
  retention (content-free by design, and recording would distort throughput).
* ``run_load`` — a closed-loop driver: N virtual clients over one shared
  ``httpx.AsyncClient``, each issuing chat completions back-to-back for the
  profile's duration; warmup outcomes are discarded so the report is
  steady-state only.
* ``run_load_processes`` — the same profile fanned across client PROCESSES.
  One asyncio/httpx client process is itself the bottleneck well before the
  gateway is: measured on a fixed box, one process driving c=64 reported
  ~128 rps at 344 ms p50 while eight c=8 processes against the same worker
  and the same single key sustained ~925 rps at 50 ms p50 — a 7x
  distortion entirely inside the client. Any step whose per-process
  concurrency exceeds ~8-16 must shard across processes or it measures the
  harness, not the platform.
* ``LoadReport`` — latency percentiles (TTFB/TTFT and total), throughput,
  an error taxonomy keyed by HTTP status and OpenAI error code, and the
  server's own ``Server-Timing`` attribution (``db_n``/``db_ms``) where the
  target emits it.

Added latency is a subtraction the caller owns: the same profile against the
worker directly and against the edge isolates the edge hop, and the
provider's own service floor (``LoopbackProvider`` timing is part of every
sample) is constant across targets by construction.

The harness deliberately reports numbers and never judges them: absolute
latency gates belong to the caller (CI gates on shape — taxonomy, ledger
consistency, per-request query counts — because runner hardware is noisy).
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import math
import multiprocessing
import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace

import httpx
import uvicorn

# One SSE completion: two content chunks, a finish chunk, a usage frame, DONE.
# Constant token counts keep every ledger row and money-gate branch identical
# across requests, so latency variance is the gateway's, not the workload's.
_PROMPT_TOKENS = 8
_COMPLETION_TOKENS = 4


def _sse(payload: dict[str, object]) -> bytes:
    """Encode one provider SSE data frame."""
    return b"data: " + json.dumps(payload).encode() + b"\n\n"


_FRAMES: tuple[bytes, ...] = (
    _sse(
        {
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": "load "},
                    "finish_reason": None,
                }
            ]
        }
    ),
    _sse({"choices": [{"index": 0, "delta": {"content": "ok"}, "finish_reason": None}]}),
    _sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}),
    _sse(
        {
            "choices": [],
            "usage": {
                "prompt_tokens": _PROMPT_TOKENS,
                "completion_tokens": _COMPLETION_TOKENS,
            },
        }
    ),
    b"data: [DONE]\n\n",
)


@dataclass(frozen=True)
class ProviderFault:
    """How the loopback upstream should misbehave, for chaos injection.

    The default is a healthy stream. Any field set makes the provider emulate
    one real upstream failure mode so the gateway's handling can be observed:

    * ``status`` != 200 answers a provider error envelope (no stream).
    * ``hang_seconds`` sleeps before responding (upstream timeout / slow-loris
      of the provider itself).
    * ``partial_then_reset`` streams the first content frame then drops the
      socket with no terminal ``[DONE]`` (mid-stream provider death).
    * ``every_nth`` (>=2) applies the fault to only 1-in-N dispatches, the
      rest healthy — flaky-provider emulation.
    """

    status: int = 200
    hang_seconds: float = 0.0
    partial_then_reset: bool = False
    every_nth: int = 1


class LoopbackProvider:
    """Deterministic OpenAI-compatible SSE upstream on a loopback port.

    Served by uvicorn in a daemon thread with its own event loop, so it
    handles concurrent keep-alive connections without the one-thread-per-
    socket ceiling of ``http.server``. Counts dispatches; retains nothing.
    An optional ``ProviderFault`` turns it into a fault injector for the
    chaos suite; unset, it is the clean benchmark upstream.
    """

    def __init__(
        self, *, frame_delay_seconds: float = 0.0, fault: ProviderFault | None = None
    ) -> None:
        """Configure the provider; ``frame_delay_seconds`` spaces SSE frames."""
        self._frame_delay_seconds = frame_delay_seconds
        self._fault = fault
        self._calls = 0
        self._calls_lock = threading.Lock()
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None
        self._port: int | None = None

    def _fault_for_call(self, call_number: int) -> ProviderFault | None:
        """Return the fault to apply to this dispatch, or None when healthy."""
        fault = self._fault
        if fault is None:
            return None
        if fault.every_nth >= 2 and call_number % fault.every_nth != 0:
            return None
        return fault

    @property
    def base_url(self) -> str:
        """The OpenAI-compatible base URL of this provider."""
        if self._port is None:
            msg = "LoopbackProvider is not started"
            raise RuntimeError(msg)
        return f"http://127.0.0.1:{self._port}/v1"

    @property
    def calls(self) -> int:
        """How many dispatches this provider has served."""
        with self._calls_lock:
            return self._calls

    async def _app(
        self,
        scope: dict[str, object],
        receive: Callable[[], Awaitable[dict[str, object]]],
        send: Callable[[dict[str, object]], Awaitable[None]],
    ) -> None:
        """Minimal ASGI app: drain the request, stream the scripted SSE."""
        if scope["type"] != "http":  # lifespan etc.
            return
        # Drain the request body without retaining it.
        while True:
            message = await receive()
            if not message.get("more_body"):
                break
        with self._calls_lock:
            self._calls += 1
            call_number = self._calls
        fault = self._fault_for_call(call_number)
        if fault is not None and fault.hang_seconds:
            await asyncio.sleep(fault.hang_seconds)
        if fault is not None and fault.status != 200:
            body = json.dumps(
                {"error": {"message": "injected provider fault", "type": "server_error"}}
            ).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": fault.status,
                    "headers": [(b"content-type", b"application/json")],
                }
            )
            await send({"type": "http.response.body", "body": body, "more_body": False})
            return
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"text/event-stream")],
            }
        )
        for index, frame in enumerate(_FRAMES):
            if fault is not None and fault.partial_then_reset and index >= 1:
                # Drop the connection mid-stream with no terminal frame: the
                # provider died after first token. more_body stays True so the
                # client sees a truncated stream, not a clean end.
                await send({"type": "http.response.body", "body": b"", "more_body": True})
                return
            if self._frame_delay_seconds:
                await asyncio.sleep(self._frame_delay_seconds)
            await send({"type": "http.response.body", "body": frame, "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    def start(self) -> None:
        """Bind an ephemeral port and serve until ``stop``."""
        config = uvicorn.Config(
            self._app,  # type: ignore[arg-type] - raw ASGI callable, no framework
            # Bind all interfaces, not just loopback: the integration path has
            # the gateway-worker CONTAINER reach this host-resident provider via
            # host.docker.internal, which on Linux routes through the docker
            # bridge gateway IP -- a 127.0.0.1-only bind is unreachable there
            # (works on Docker Desktop, fails in Linux CI). Ephemeral in-process
            # test server on a random port, so binding all interfaces is safe.
            host="0.0.0.0",  # noqa: S104 - ephemeral test provider; see comment
            port=0,
            log_level="critical",
            access_log=False,
            lifespan="off",
            # A bound method defeats uvicorn's ASGI2/3 signature sniffing; the
            # app is ASGI3, say so explicitly.
            interface="asgi3",
            # The provider is the measurement floor every gateway report is
            # compared against, so pin its loop and parser: uvicorn's "auto"
            # would silently upgrade it whenever uvloop/httptools are installed
            # (they are, for the serving pods) and move the floor between runs.
            loop="asyncio",
            http="h11",
        )
        server = uvicorn.Server(config)
        self._server = server
        started = threading.Event()

        def _serve() -> None:
            async def _run() -> None:
                # Serve and surface the bound port before the first request.
                task = asyncio.create_task(server.serve())
                # uvicorn exposes readiness only as a bool, so a short poll is
                # the sanctioned wait here.
                while not server.started and not task.done():  # noqa: ASYNC110
                    await asyncio.sleep(0.01)
                if server.servers:
                    sockets = server.servers[0].sockets or []
                    if sockets:
                        self._port = sockets[0].getsockname()[1]
                started.set()
                await task

            asyncio.run(_run())

        thread = threading.Thread(target=_serve, name="load-loopback-provider", daemon=True)
        self._thread = thread
        thread.start()
        if not started.wait(timeout=10) or self._port is None:
            msg = "LoopbackProvider failed to start"
            raise RuntimeError(msg)

    def stop(self) -> None:
        """Shut the server down and join its thread."""
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=10)


@dataclass(frozen=True)
class LoadProfile:
    """One load run's shape: closed-loop concurrency for a fixed duration."""

    concurrency: int
    duration_seconds: float
    warmup_seconds: float = 2.0
    stream: bool = True
    prompt: str = "load"


@dataclass(frozen=True)
class ServerTiming:
    """Parsed ``Server-Timing`` attribution emitted by the platform."""

    app_ms: float | None = None
    db_ms: float | None = None
    db_calls: int | None = None
    db_wait_ms: float | None = None


@dataclass(frozen=True)
class RequestOutcome:
    """One request's observation."""

    started_at: float
    status: int
    ttfb_ms: float
    total_ms: float
    error_code: str | None = None
    server_timing: ServerTiming | None = None


@dataclass(frozen=True)
class Percentiles:
    """Latency distribution over one metric, milliseconds."""

    count: int
    p50: float
    p90: float
    p99: float
    p999: float
    maximum: float
    minimum: float

    @staticmethod
    def of(samples: list[float]) -> Percentiles:
        """Compute the distribution; requires at least one sample."""
        if not samples:
            msg = "percentiles need at least one sample"
            raise ValueError(msg)
        ordered = sorted(samples)

        def at(quantile: float) -> float:
            index = min(len(ordered) - 1, math.ceil(quantile * len(ordered)) - 1)
            return ordered[max(0, index)]

        return Percentiles(
            count=len(ordered),
            p50=at(0.50),
            p90=at(0.90),
            p99=at(0.99),
            p999=at(0.999),
            maximum=ordered[-1],
            minimum=ordered[0],
        )


@dataclass(frozen=True)
class LoadReport:
    """One run's steady-state result."""

    target: str
    profile: LoadProfile
    completed: int
    throughput_rps: float
    ttfb: Percentiles
    total: Percentiles
    outcomes_by_status: dict[str, int]
    db_calls_per_request: float | None
    provider_calls: int
    # Server-Timing attribution distributions, present only when the target
    # emits the header (local/CI stacks; hosted keeps it off). ``db_ms`` is
    # wire time inside the request, ``db_wait_ms`` is pool-checkout wait —
    # the two split "database slow" from "pool starved" without guessing.
    db_ms: Percentiles | None = None
    db_wait_ms: Percentiles | None = None

    def to_json(self) -> str:
        """Serialize for artifacts/step summaries."""
        return json.dumps(
            {
                "target": self.target,
                "concurrency": self.profile.concurrency,
                "duration_seconds": self.profile.duration_seconds,
                "stream": self.profile.stream,
                "completed": self.completed,
                "throughput_rps": round(self.throughput_rps, 2),
                "ttfb_ms": {
                    "p50": round(self.ttfb.p50, 2),
                    "p90": round(self.ttfb.p90, 2),
                    "p99": round(self.ttfb.p99, 2),
                    "max": round(self.ttfb.maximum, 2),
                },
                "total_ms": {
                    "p50": round(self.total.p50, 2),
                    "p90": round(self.total.p90, 2),
                    "p99": round(self.total.p99, 2),
                    "max": round(self.total.maximum, 2),
                },
                "outcomes_by_status": self.outcomes_by_status,
                "db_calls_per_request": self.db_calls_per_request,
                "db_ms": _percentiles_json(self.db_ms),
                "db_wait_ms": _percentiles_json(self.db_wait_ms),
                "provider_calls": self.provider_calls,
            },
            indent=2,
        )


def _percentiles_json(percentiles: Percentiles | None) -> dict[str, float] | None:
    """Serialize one optional distribution for the report artifact."""
    if percentiles is None:
        return None
    return {
        "p50": round(percentiles.p50, 2),
        "p90": round(percentiles.p90, 2),
        "p99": round(percentiles.p99, 2),
        "max": round(percentiles.maximum, 2),
    }


def _timing_entry(entry: str) -> tuple[str, float | None, str | None]:
    """Split one Server-Timing entry into (name, dur, desc)."""
    parts = [part.strip() for part in entry.strip().split(";")]
    name = parts[0] if parts else ""
    duration: float | None = None
    description: str | None = None
    for part in parts[1:]:
        if part.startswith("dur="):
            try:
                duration = float(part[4:])
            except ValueError:
                duration = None
        elif part.startswith("desc="):
            description = part[5:].strip('"')
    return name, duration, description


def _query_count(description: str | None) -> int | None:
    """Parse the ``"3q"`` query-count description, tolerant of junk."""
    if description is None or not description.endswith("q"):
        return None
    try:
        return int(description[:-1])
    except ValueError:
        return None


def parse_server_timing(header: str | None) -> ServerTiming | None:
    """Parse the platform's ``Server-Timing`` header, tolerant of absence.

    Shape emitted by ``explabs/api/request_timing.py``:
    ``app;dur=12.3, db;dur=4.5;desc="3q", dbwait;dur=0.1``.
    """
    if not header:
        return None
    app_ms: float | None = None
    db_ms: float | None = None
    db_calls: int | None = None
    db_wait_ms: float | None = None
    for entry in header.split(","):
        name, duration, description = _timing_entry(entry)
        match name:
            case "app":
                app_ms = duration
            case "db":
                db_ms = duration
                db_calls = _query_count(description)
            case "dbwait":
                db_wait_ms = duration
            case _:
                continue
    if app_ms is None and db_ms is None and db_wait_ms is None:
        return None
    return ServerTiming(app_ms=app_ms, db_ms=db_ms, db_calls=db_calls, db_wait_ms=db_wait_ms)


@dataclass
class _RunState:
    """Mutable collection shared by the virtual clients."""

    outcomes: list[RequestOutcome] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


async def _one_request(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    api_key: str,
    model: str,
    profile: LoadProfile,
) -> RequestOutcome:
    """Issue one chat completion and time TTFB and total."""
    body = {
        "model": model,
        "messages": [{"role": "user", "content": profile.prompt}],
        "stream": profile.stream,
    }
    started_wall = time.time()
    started = time.perf_counter()
    ttfb_ms = 0.0
    error_code: str | None = None
    status = 0
    server_timing: ServerTiming | None = None
    try:
        async with client.stream(
            "POST",
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json=body,
        ) as response:
            status = response.status_code
            server_timing = parse_server_timing(response.headers.get("server-timing"))
            first = True
            collected = bytearray()
            async for chunk in response.aiter_raw():
                if first:
                    ttfb_ms = (time.perf_counter() - started) * 1000
                    first = False
                if status >= 400:
                    collected.extend(chunk)
            if first:
                # Empty body: TTFB is headers-only.
                ttfb_ms = (time.perf_counter() - started) * 1000
            if status >= 400 and collected:
                try:
                    error = json.loads(bytes(collected)).get("error", {})
                    code = error.get("code")
                    error_code = code if isinstance(code, str) else None
                except (json.JSONDecodeError, AttributeError):
                    error_code = "non_json_error_body"
    except httpx.HTTPError as error:
        status = -1
        error_code = type(error).__name__
        ttfb_ms = (time.perf_counter() - started) * 1000
    total_ms = (time.perf_counter() - started) * 1000
    return RequestOutcome(
        started_at=started_wall,
        status=status,
        ttfb_ms=ttfb_ms,
        total_ms=total_ms,
        error_code=error_code,
        server_timing=server_timing,
    )


async def _collect_steady_outcomes(
    *,
    base_url: str,
    api_key: str,
    model: str,
    profile: LoadProfile,
) -> list[RequestOutcome]:
    """Drive one closed-loop profile and return its steady-state outcomes.

    Virtual clients share one ``httpx.AsyncClient`` (keep-alive pool sized to
    the concurrency) and issue requests back to back; outcomes whose start
    falls inside the warmup window are discarded.
    """
    state = _RunState()
    deadline = time.perf_counter() + profile.warmup_seconds + profile.duration_seconds
    warmup_until = time.time() + profile.warmup_seconds
    limits = httpx.Limits(
        max_connections=profile.concurrency,
        max_keepalive_connections=profile.concurrency,
        keepalive_expiry=60.0,
    )
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(120.0, connect=10.0), limits=limits
    ) as client:

        async def virtual_client() -> None:
            while time.perf_counter() < deadline:
                outcome = await _one_request(
                    client, base_url=base_url, api_key=api_key, model=model, profile=profile
                )
                async with state.lock:
                    state.outcomes.append(outcome)
                if outcome.status < 0:
                    # Transport failure (refused/reset): pace the retry so a
                    # dead target yields an error-taxonomy report instead of a
                    # closed loop spinning at CPU speed on instant failures.
                    await asyncio.sleep(0.05)

        await asyncio.gather(*(virtual_client() for _ in range(profile.concurrency)))

    return [outcome for outcome in state.outcomes if outcome.started_at >= warmup_until]


async def run_load(
    *,
    target_name: str,
    base_url: str,
    api_key: str,
    model: str,
    profile: LoadProfile,
    provider: LoopbackProvider | None = None,
) -> LoadReport:
    """Run one closed-loop profile in this process; steady-state report.

    One process is honest only up to a per-process concurrency of roughly
    8-16 (see the module docstring); above that use ``run_load_processes``.
    """
    provider_calls_before = provider.calls if provider is not None else 0
    steady = await _collect_steady_outcomes(
        base_url=base_url, api_key=api_key, model=model, profile=profile
    )
    return report_from_outcomes(
        target_name=target_name,
        profile=profile,
        steady=steady,
        provider_calls=(provider.calls - provider_calls_before) if provider is not None else 0,
    )


def report_from_outcomes(
    *,
    target_name: str,
    profile: LoadProfile,
    steady: list[RequestOutcome],
    provider_calls: int,
) -> LoadReport:
    """Aggregate steady-state outcomes (one process's or many merged) into a report.

    Raises:
        RuntimeError: No steady-state samples were collected.
    """
    if not steady:
        msg = "load run produced no steady-state samples; lengthen the duration"
        raise RuntimeError(msg)
    by_status: dict[str, int] = {}
    for outcome in steady:
        key = (
            str(outcome.status)
            if outcome.error_code is None
            else (f"{outcome.status}:{outcome.error_code}")
        )
        by_status[key] = by_status.get(key, 0) + 1
    timed = [outcome for outcome in steady if outcome.status == 200]
    samples = timed or steady
    db_counts = [
        outcome.server_timing.db_calls
        for outcome in steady
        if outcome.server_timing is not None and outcome.server_timing.db_calls is not None
    ]
    db_times = [
        outcome.server_timing.db_ms
        for outcome in steady
        if outcome.server_timing is not None and outcome.server_timing.db_ms is not None
    ]
    db_waits = [
        outcome.server_timing.db_wait_ms
        for outcome in steady
        if outcome.server_timing is not None and outcome.server_timing.db_wait_ms is not None
    ]
    return LoadReport(
        target=target_name,
        profile=profile,
        completed=len(steady),
        throughput_rps=len(steady) / profile.duration_seconds,
        ttfb=Percentiles.of([outcome.ttfb_ms for outcome in samples]),
        total=Percentiles.of([outcome.total_ms for outcome in samples]),
        outcomes_by_status=by_status,
        db_calls_per_request=(sum(db_counts) / len(db_counts)) if db_counts else None,
        db_ms=Percentiles.of(db_times) if db_times else None,
        db_wait_ms=Percentiles.of(db_waits) if db_waits else None,
        provider_calls=provider_calls,
    )


def _shard_concurrency(total: int, processes: int) -> list[int]:
    """Split a total concurrency across processes, dropping empty shards.

    Args:
        total: Total virtual clients across every process.
        processes: Requested process count.

    Returns:
        Near-even positive shards summing to ``total``; fewer than
        ``processes`` entries when ``total`` cannot feed them all.
    """
    if total < 1 or processes < 1:
        msg = "concurrency and processes must both be at least 1"
        raise ValueError(msg)
    base, remainder = divmod(total, processes)
    shards = [base + (1 if index < remainder else 0) for index in range(processes)]
    return [shard for shard in shards if shard > 0]


def _collect_in_process(
    base_url: str, api_key: str, model: str, profile: LoadProfile
) -> list[RequestOutcome]:
    """Child-process entry: run one shard's closed loop on a fresh event loop."""
    return asyncio.run(
        _collect_steady_outcomes(base_url=base_url, api_key=api_key, model=model, profile=profile)
    )


def run_load_processes(
    *,
    target_name: str,
    base_url: str,
    api_key: str,
    model: str,
    profile: LoadProfile,
    processes: int,
    provider: LoopbackProvider | None = None,
) -> LoadReport:
    """Run one profile fanned across client processes; one merged report.

    ``profile.concurrency`` is the TOTAL across all shards. Multiprocessing
    (not threads, not more tasks) is load-bearing here: a single asyncio
    client process anti-scales past ~8-16 concurrent streams and reports the
    harness's own ceiling as the target's (module docstring has the measured
    7x distortion). Each child discards its own warmup window, which also
    absorbs process start skew; every child runs the same duration, so the
    merged throughput is total steady completions over that duration.

    Args:
        target_name: Report label.
        base_url: OpenAI-compatible base URL under test.
        api_key: Bearer key for every shard.
        model: Model alias every shard requests.
        profile: Total-concurrency closed-loop profile.
        processes: Client process count (``1`` degrades to in-process).
        provider: Optional loopback provider for the dispatch-count delta.

    Returns:
        One steady-state report over every shard's merged outcomes.
    """
    shards = _shard_concurrency(profile.concurrency, processes)
    if len(shards) == 1:
        return asyncio.run(
            run_load(
                target_name=target_name,
                base_url=base_url,
                api_key=api_key,
                model=model,
                profile=profile,
                provider=provider,
            )
        )
    provider_calls_before = provider.calls if provider is not None else 0
    # Spawned children re-import this module fresh; the profile and outcome
    # dataclasses cross the boundary by pickle.
    context = multiprocessing.get_context("spawn")
    steady: list[RequestOutcome] = []
    with concurrent.futures.ProcessPoolExecutor(
        max_workers=len(shards), mp_context=context
    ) as pool:
        futures = [
            pool.submit(
                _collect_in_process,
                base_url,
                api_key,
                model,
                replace(profile, concurrency=shard),
            )
            for shard in shards
        ]
        for future in futures:
            steady.extend(future.result())
    return report_from_outcomes(
        target_name=target_name,
        profile=profile,
        steady=steady,
        provider_calls=(provider.calls - provider_calls_before) if provider is not None else 0,
    )
