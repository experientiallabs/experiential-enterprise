# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Per-model live-call harness for the gateway catalog (core-P18).

the product owner's standard, verbatim and repeated: "We should have a unit test per model
every time we integrate it." This module is that test, made data-driven so the
guarantee cannot fall behind the catalog: it collects one case PER PUBLIC MODEL
straight from the ``models`` table, so adding a model automatically adds its
test, and no model can ship without one.

Because most hosted providers need real keys the preview does not hold yet, the
harness is environment-aware rather than all-or-nothing:

* A model the live gateway actually serves (its slug appears in
  ``GET /v1/models``, meaning a provider connection or house-org credential
  resolves for it in THIS environment) gets a real completion through the
  gateway. The call must return either a well-formed ``200`` with usage
  recorded, or a cleanly classified OpenAI error envelope (an upstream that
  does not serve the wire id is the provider's verdict, not a gateway defect).
* A model with no routable provider in this environment is SKIPPED with a clear
  reason, never failed, so the suite is green now and grows comprehensive as
  credentials arrive: the day the product owner's OpenAI and Gemini keys reach the worker,
  those slugs enter ``GET /v1/models`` and flip from skipped to live with no
  code change.

The harness targets an ALREADY-RUNNING gateway (``EXPLABS_PERMODEL_GATEWAY_URL``,
e.g. the everything-preview worker) so it boots no new stack; it seeds one
throwaway org and key on the platform Postgres (``SUPABASE_DB_URL``) to make
authenticated calls, removed on teardown. It is ``integration``-marked and
doubly gated on those two coordinates, so a plain ``pytest`` run collects the
cases and skips them.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import cast

import httpx
import psycopg
import pytest

from explabs.gateway.conftest import GatewayHarness

pytestmark = pytest.mark.integration

# Small budgets keep the dogfood cheap; large enough that a reasoning model
# emits visible content rather than spending the whole budget on thinking.
_MAX_TOKENS = 64
_REQUEST_TIMEOUT_SECONDS = 60.0
# The settle path writes the usage event just after the response returns; poll
# briefly rather than sleeping a fixed interval.
_USAGE_EVENT_POLL_SECONDS = 8.0
_USAGE_EVENT_POLL_INTERVAL_SECONDS = 0.25

# Finish reasons that make an empty completion legitimate (the budget or a
# provider stop cut the answer before any content token).
_EMPTY_CONTENT_FINISH_REASONS = frozenset({"length", "content_filter", "stop", "incomplete"})


def _public_catalog_slugs(dsn: str) -> list[str]:
    """Read the active public catalog slugs in stable order (read-only)."""
    with psycopg.connect(dsn, autocommit=True) as connection:
        rows = connection.execute(
            """
            select slug
              from public.models
             where owning_org_id is null
               and status = 'active'
             order by slug
            """
        ).fetchall()
    return [str(row[0]) for row in rows]


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    """Parametrize one case per public catalog model, straight from the DB.

    Collection reads the catalog so the parametrization is the catalog: the
    case list is exactly today's public models. With no database configured the
    module still collects, as a single skipped case, so the suite stays green.
    """
    if "catalog_slug" not in metafunc.fixturenames:
        return
    dsn = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not dsn:
        metafunc.parametrize(
            "catalog_slug",
            [
                pytest.param(
                    "",
                    marks=pytest.mark.skip(
                        reason="SUPABASE_DB_URL required to enumerate the catalog"
                    ),
                )
            ],
        )
        return
    slugs = _public_catalog_slugs(dsn)
    if not slugs:
        metafunc.parametrize(
            "catalog_slug",
            [pytest.param("", marks=pytest.mark.skip(reason="no public catalog models found"))],
        )
        return
    metafunc.parametrize("catalog_slug", slugs, ids=slugs)


@dataclass(frozen=True)
class LiveGateway:
    """A running gateway plus a throwaway key and a read connection to its DB."""

    base_url: str
    api_key: str
    org_id: str
    connection: psycopg.Connection[tuple[object, ...]]


def _require(name: str) -> str:
    """Return a required environment coordinate or skip the whole module."""
    value = os.environ.get(name, "").strip()
    if not value:
        pytest.skip(f"{name} is required for the per-model live harness")
    return value


@pytest.fixture(scope="module")
def live_gateway() -> Iterator[LiveGateway]:
    """Seed one throwaway org and key against a running gateway, read-only else.

    The org and key are the only rows written; teardown removes them (and any
    usage the calls recorded for that org). Nothing in the catalog is touched,
    so the harness is safe to run against the shared everything-preview stack.
    """
    gateway_url = _require("EXPLABS_PERMODEL_GATEWAY_URL")
    dsn = _require("SUPABASE_DB_URL")
    harness = GatewayHarness(dsn)
    connection = psycopg.connect(dsn, autocommit=True)
    try:
        org_id = harness.seed_org()
        key = harness.seed_key(org_id)
        yield LiveGateway(
            base_url=gateway_url.rstrip("/"),
            api_key=key.raw_key,
            org_id=org_id,
            connection=connection,
        )
    finally:
        connection.close()
        harness.close()


@pytest.fixture(scope="module")
def routable_model_ids(live_gateway: LiveGateway) -> frozenset[str]:
    """The slugs the live gateway actually serves, from ``GET /v1/models``."""
    with httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
        response = client.get(
            f"{live_gateway.base_url}/v1/models",
            headers={"Authorization": f"Bearer {live_gateway.api_key}"},
        )
    response.raise_for_status()
    return frozenset(str(entry["id"]) for entry in response.json().get("data", []))


def _skip_if_not_routable(catalog_slug: str, routable: frozenset[str]) -> None:
    """Skip a model with no routable provider in this environment."""
    if not catalog_slug:
        pytest.skip("no catalog model for this case")
    if catalog_slug not in routable:
        pytest.skip(f"no routable provider for {catalog_slug} in this environment")


def _org_usage_event_count(gateway: LiveGateway) -> int:
    """Count usage events recorded for the throwaway org so far."""
    row = gateway.connection.execute(
        "select count(*) from public.gateway_usage_events where org_id = %s",
        (gateway.org_id,),
    ).fetchone()
    return int(cast("int", row[0])) if row is not None else 0


def _await_usage_event(gateway: LiveGateway, *, above: int) -> bool:
    """Poll until the org's usage-event count exceeds ``above`` or time runs out."""
    deadline = time.monotonic() + _USAGE_EVENT_POLL_SECONDS
    while time.monotonic() < deadline:
        if _org_usage_event_count(gateway) > above:
            return True
        time.sleep(_USAGE_EVENT_POLL_INTERVAL_SECONDS)
    return False


def _assert_well_formed_error(response: httpx.Response, slug: str) -> None:
    """Assert a non-200 is a cleanly classified OpenAI error, not a crash."""
    assert response.status_code != 500, (
        f"{slug}: gateway returned an unclassified 500:\n{response.text[:600]}"
    )
    try:
        payload = response.json()
    except json.JSONDecodeError as decode_error:
        message = (
            f"{slug}: error response was not JSON (HTTP {response.status_code}): {decode_error}"
        )
        raise AssertionError(message) from decode_error
    error = payload.get("error")
    assert isinstance(error, dict), f"{slug}: error body has no error object: {payload}"
    error_type = error.get("type")
    error_message = error.get("message")
    assert isinstance(error_type, str), f"{slug}: error envelope type is not a string: {error}"
    assert error_type, f"{slug}: error envelope missing a type: {error}"
    assert isinstance(error_message, str), f"{slug}: error message is not a string: {error}"
    assert error_message, f"{slug}: error envelope missing a message: {error}"
    print(
        f"[per-model] {slug}: classified error HTTP {response.status_code} code={error.get('code')}"
    )


def test_model_chat_completion(
    catalog_slug: str,
    live_gateway: LiveGateway,
    routable_model_ids: frozenset[str],
) -> None:
    """Every routable model answers ``/v1/chat/completions`` well or fails cleanly.

    A ``200`` must carry usage and a recorded usage event (cost computed, or the
    unknown-cost lane that bills zero); empty content is allowed only when the
    finish reason explains it. A non-200 must be a classified error envelope.
    """
    _skip_if_not_routable(catalog_slug, routable_model_ids)
    before = _org_usage_event_count(live_gateway)
    with httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
        response = client.post(
            f"{live_gateway.base_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {live_gateway.api_key}"},
            json={
                "model": catalog_slug,
                "messages": [{"role": "user", "content": "Reply with the single word: OK"}],
                "max_tokens": _MAX_TOKENS,
            },
        )
    if response.status_code != 200:
        _assert_well_formed_error(response, catalog_slug)
        return
    payload = response.json()
    choices = payload.get("choices")
    assert choices, f"{catalog_slug}: 200 with no choices: {payload}"
    message = choices[0].get("message", {})
    content = message.get("content")
    finish_reason = choices[0].get("finish_reason")
    usage = payload.get("usage")
    assert isinstance(usage, dict), f"{catalog_slug}: 200 without usage: {payload}"
    prompt_tokens = int(usage.get("prompt_tokens", 0))
    completion_tokens = int(usage.get("completion_tokens", 0))
    total_tokens = int(usage.get("total_tokens", 0))
    assert prompt_tokens > 0, f"{catalog_slug}: no prompt tokens: {usage}"
    assert total_tokens > 0, f"{catalog_slug}: no total tokens: {usage}"
    # A model may answer with text, or spend its whole budget on reasoning and
    # return null/empty content, which is still a legitimate 200. Accept the
    # empty case only when the response proves the model engaged (completion
    # tokens spent, or a finish reason that explains the silence), never a
    # blank, token-free reply that would mean the gateway returned nothing.
    assert content is None or isinstance(content, str), (
        f"{catalog_slug}: message content is neither text nor null: {message}"
    )
    if not content:
        assert completion_tokens > 0 or finish_reason in _EMPTY_CONTENT_FINISH_REASONS, (
            f"{catalog_slug}: empty content with no completion tokens and "
            f"finish_reason={finish_reason}: {usage}"
        )
    assert _await_usage_event(live_gateway, above=before), (
        f"{catalog_slug}: no gateway_usage_events row recorded after a 200 completion"
    )
    print(
        f"[per-model] {catalog_slug}: chat 200 finish={finish_reason} "
        f"tokens={total_tokens} content={(content or '')[:40]!r}"
    )


def test_model_responses_api(
    catalog_slug: str,
    live_gateway: LiveGateway,
    routable_model_ids: frozenset[str],
) -> None:
    """Every routable model answers ``/v1/responses`` well or fails cleanly."""
    _skip_if_not_routable(catalog_slug, routable_model_ids)
    with httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS) as client:
        response = client.post(
            f"{live_gateway.base_url}/v1/responses",
            headers={"Authorization": f"Bearer {live_gateway.api_key}"},
            json={
                "model": catalog_slug,
                "input": "Reply with the single word: OK",
                "max_output_tokens": _MAX_TOKENS,
            },
        )
    if response.status_code != 200:
        _assert_well_formed_error(response, catalog_slug)
        return
    payload = response.json()
    assert payload.get("output") is not None or payload.get("output_text") is not None, (
        f"{catalog_slug}: responses 200 with no output: {payload}"
    )
    usage = payload.get("usage")
    assert isinstance(usage, dict), f"{catalog_slug}: responses 200 without usage: {payload}"
    print(f"[per-model] {catalog_slug}: responses 200 usage={usage}")


def test_model_streaming(
    catalog_slug: str,
    live_gateway: LiveGateway,
    routable_model_ids: frozenset[str],
) -> None:
    """Every routable model streams SSE cleanly or fails cleanly.

    A streamed ``200`` must deliver at least one well-formed ``data:`` event and
    terminate with ``[DONE]``; a non-200 must be a classified error envelope.
    """
    _skip_if_not_routable(catalog_slug, routable_model_ids)
    with (
        httpx.Client(timeout=_REQUEST_TIMEOUT_SECONDS) as client,
        client.stream(
            "POST",
            f"{live_gateway.base_url}/v1/chat/completions",
            headers={"Authorization": f"Bearer {live_gateway.api_key}"},
            json={
                "model": catalog_slug,
                "messages": [{"role": "user", "content": "Reply with the single word: OK"}],
                "max_tokens": _MAX_TOKENS,
                "stream": True,
            },
        ) as response,
    ):
        if response.status_code != 200:
            response.read()
            _assert_well_formed_error(response, catalog_slug)
            return
        events = 0
        saw_done = False
        for line in response.iter_lines():
            if not line.startswith("data:"):
                continue
            data = line[len("data:") :].strip()
            if data == "[DONE]":
                saw_done = True
                break
            json.loads(data)
            events += 1
    assert events > 0, f"{catalog_slug}: stream produced no data events"
    assert saw_done, f"{catalog_slug}: stream did not terminate with [DONE]"
    print(f"[per-model] {catalog_slug}: streamed {events} events")
