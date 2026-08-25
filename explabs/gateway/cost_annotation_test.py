# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the additive usage.cost extension on the /v1 completion surface."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

from exp.runtime.openai_protocol.streaming import stable_public_id
from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.testclient import TestClient

from explabs.gateway.cost_annotation import (
    CostRegistry,
    SettledCost,
    UsageCostAnnotator,
    annotate_completion_payload,
    public_response_digest,
)


class TestDigest:
    """The registry key must match the digest exp embeds in public ids."""

    def test_matches_exp_stable_public_id(self) -> None:
        """chatcmpl_ and resp_ ids share the digest for one request."""
        digest = public_response_digest("request-123")
        assert stable_public_id("chatcmpl", "request-123") == f"chatcmpl_{digest}"
        assert stable_public_id("resp", "request-123") == f"resp_{digest}"


class TestSettledCostFields:
    """usage.cost is the charged amount, added beside OpenAI's usage fields."""

    def test_platform_funded_reports_the_settled_charge(self) -> None:
        """host_managed cost is budget_settled (discounts already applied)."""
        settled = SettledCost(billed_micro_usd=1_080, billing_source="host_managed")
        assert settled.usage_fields() == {"cost": 0.00108}

    def test_promo_funded_reports_zero(self) -> None:
        """Promo rows settle budget_settled to 0, so the caller paid nothing."""
        settled = SettledCost(billed_micro_usd=0, billing_source="host_managed")
        assert settled.usage_fields() == {"cost": 0.0}

    def test_byok_reports_zero(self) -> None:
        """customer_managed is never charged; its attributed value is not a charge."""
        settled = SettledCost(billed_micro_usd=120, billing_source="customer_managed")
        assert settled.usage_fields() == {"cost": 0.0}


class TestCostRegistry:
    """The registry hands one settled record from the ledger to the annotator."""

    def test_record_pop_roundtrip_consumes_the_entry(self) -> None:
        """Pop returns the record once, then misses."""
        registry = CostRegistry()
        settled = SettledCost(billed_micro_usd=7, billing_source="host_managed")
        registry.record(request_id="request-1", settled=settled)
        digest = public_response_digest("request-1")
        assert registry.pop(digest) == settled
        assert registry.pop(digest) is None

    def test_overflow_evicts_the_oldest_entries(self) -> None:
        """Entries responses never consumed (Rust-served) age out FIFO."""
        registry = CostRegistry(capacity=2)
        settled = SettledCost(billed_micro_usd=1, billing_source="host_managed")
        for index in range(3):
            registry.record(request_id=f"request-{index}", settled=settled)
        assert registry.pop(public_response_digest("request-0")) is None
        assert registry.pop(public_response_digest("request-2")) == settled


class TestAnnotateCompletionPayload:
    """Every usage-bearing payload shape exp emits gains the settled cost."""

    def _registry(self, request_id: str = "request-1") -> CostRegistry:
        registry = CostRegistry()
        registry.record(
            request_id=request_id,
            settled=SettledCost(billed_micro_usd=120, billing_source="host_managed"),
        )
        return registry

    def test_chat_body_and_usage_chunk_shape(self) -> None:
        """Top-level id + usage (non-streaming body and final usage chunk)."""
        payload = {
            "id": stable_public_id("chatcmpl", "request-1"),
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }
        assert annotate_completion_payload(payload, self._registry())
        assert payload["usage"]["cost"] == 0.00012

    def test_responses_terminal_event_shape(self) -> None:
        """The Responses SSE terminal event nests the envelope under response."""
        payload = {
            "type": "response.completed",
            "response": {
                "id": stable_public_id("resp", "request-1"),
                "usage": {"input_tokens": 10, "output_tokens": 5},
            },
        }
        assert annotate_completion_payload(payload, self._registry())
        assert payload["response"]["usage"]["cost"] == 0.00012

    def test_untouched_without_usage_or_registry_entry(self) -> None:
        """Null usage, malformed ids, and registry misses change nothing."""
        registry = self._registry()
        assert not annotate_completion_payload({"id": "chatcmpl_x", "usage": None}, registry)
        assert not annotate_completion_payload({"usage": {"prompt_tokens": 1}}, registry)
        miss = {"id": "chatcmpl_unknown", "usage": {"prompt_tokens": 1}}
        assert not annotate_completion_payload(miss, registry)
        assert "cost" not in miss["usage"]


def _chat_completion_body(request_id: str) -> dict[str, object]:
    """The non-streaming Chat body exp assembles, reduced to what matters."""
    return {
        "id": stable_public_id("chatcmpl", request_id),
        "object": "chat.completion",
        "model": "qwen3.8-27b",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "OK"}}],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 5,
            "total_tokens": 15,
            "prompt_tokens_details": None,
            "completion_tokens_details": None,
        },
    }


def _sse_frames(request_id: str) -> list[bytes]:
    """A streamed completion: delta frame, usage frame, and [DONE]."""
    completion_id = stable_public_id("chatcmpl", request_id)
    delta = json.dumps(
        {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "choices": [{"delta": {"content": "OK"}}],
        },
        separators=(",", ":"),
    )
    usage = json.dumps(
        {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "choices": [],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        },
        separators=(",", ":"),
    )
    return [f"data: {delta}\n\n".encode(), f"data: {usage}\n\n".encode(), b"data: [DONE]\n\n"]


def _annotated_app(registry: CostRegistry) -> FastAPI:
    """A stand-in for the exp mount emitting canned /v1 payloads."""
    app = FastAPI()

    @app.post("/v1/chat/completions")
    async def chat() -> JSONResponse:
        return JSONResponse(_chat_completion_body("request-1"))

    @app.post("/v1/responses")
    async def responses() -> JSONResponse:
        return JSONResponse(
            {
                "id": stable_public_id("resp", "request-1"),
                "object": "response",
                "usage": {"input_tokens": 10, "output_tokens": 5},
            }
        )

    @app.post("/v1/chat/completions/streamed")
    async def unrelated() -> JSONResponse:
        return JSONResponse({"usage": {"prompt_tokens": 1}})

    app.add_middleware(UsageCostAnnotator, registry=registry)
    return app


def _streaming_app(registry: CostRegistry, chunks: list[bytes]) -> FastAPI:
    """A stand-in mount that streams the given SSE byte chunks."""
    app = FastAPI()

    @app.post("/v1/chat/completions")
    async def chat() -> StreamingResponse:
        async def body() -> AsyncIterator[bytes]:
            for chunk in chunks:
                yield chunk

        return StreamingResponse(body(), media_type="text/event-stream")

    app.add_middleware(UsageCostAnnotator, registry=registry)
    return app


def _recorded_registry() -> CostRegistry:
    registry = CostRegistry()
    registry.record(
        request_id="request-1",
        settled=SettledCost(billed_micro_usd=120, billing_source="host_managed"),
    )
    return registry


class TestAnnotatorMiddleware:
    """The ASGI seam rewrites finished completion payloads and nothing else."""

    def test_non_streaming_chat_gains_cost_with_a_valid_content_length(self) -> None:
        """usage.cost lands in the JSON body beside OpenAI's untouched fields."""
        client = TestClient(_annotated_app(_recorded_registry()))
        response = client.post("/v1/chat/completions")
        assert response.status_code == 200
        assert int(response.headers["content-length"]) == len(response.content)
        usage = response.json()["usage"]
        assert usage["cost"] == 0.00012
        # OpenAI-defined usage fields are untouched beside the extension.
        assert usage["prompt_tokens"] == 10
        assert usage["prompt_tokens_details"] is None
        # The rest of the payload is preserved.
        assert response.json()["choices"][0]["message"]["content"] == "OK"

    def test_responses_surface_gains_cost(self) -> None:
        """The Responses envelope's usage block is annotated the same way."""
        client = TestClient(_annotated_app(_recorded_registry()))
        usage = client.post("/v1/responses").json()["usage"]
        assert usage["cost"] == 0.00012

    def test_registry_miss_leaves_the_body_byte_identical(self) -> None:
        """Replays and Rust-settled requests pass through untouched."""
        client = TestClient(_annotated_app(CostRegistry()))
        body = client.post("/v1/chat/completions").json()
        assert "cost" not in body["usage"]

    def test_streaming_usage_frame_gains_cost_and_deltas_pass_through(self) -> None:
        """Only the usage-bearing frame is rewritten; [DONE] survives."""
        frames = _sse_frames("request-1")
        client = TestClient(_streaming_app(_recorded_registry(), frames))
        with client.stream("POST", "/v1/chat/completions") as response:
            raw = b"".join(response.iter_raw())
        out_frames = raw.split(b"\n\n")
        assert out_frames[0] == frames[0].removesuffix(b"\n\n")
        usage_payload = json.loads(out_frames[1].removeprefix(b"data: "))
        assert usage_payload["usage"]["cost"] == 0.00012
        assert out_frames[2] == b"data: [DONE]"

    def test_streaming_frames_split_across_chunks_are_reassembled(self) -> None:
        """A frame split mid-JSON across body chunks still rewrites cleanly."""
        frames = _sse_frames("request-1")
        blob = b"".join(frames)
        chunks = [blob[index : index + 7] for index in range(0, len(blob), 7)]
        client = TestClient(_streaming_app(_recorded_registry(), chunks))
        with client.stream("POST", "/v1/chat/completions") as response:
            raw = b"".join(response.iter_raw())
        usage_payload = json.loads(raw.split(b"\n\n")[1].removeprefix(b"data: "))
        assert usage_payload["usage"]["cost"] == 0.00012
        assert raw.endswith(b"data: [DONE]\n\n")

    def test_unrelated_paths_pass_through(self) -> None:
        """Only the two completion paths are touched."""
        client = TestClient(_annotated_app(_recorded_registry()))
        body = client.post("/v1/chat/completions/streamed").json()
        assert "cost" not in body["usage"]

    def test_keyed_requests_pass_through_for_replay_byte_exactness(self) -> None:
        """Replayable requests are never annotated.

        exp's idempotency and continuation replays return the retained bytes
        (possibly from another worker), so the original must not carry a field
        a replay cannot reproduce (e2e S3 pins replay.content == first.content).
        """
        for header in ("Idempotency-Key", "X-Client-Request-Id"):
            client = TestClient(_annotated_app(_recorded_registry()))
            body = client.post("/v1/chat/completions", headers={header: "op-1"}).json()
            assert "cost" not in body["usage"], header
