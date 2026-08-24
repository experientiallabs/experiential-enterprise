# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Frontier list-price anchor for the serving-request cost comparison.

Deliberately a LEAF at the package root: engine modules consume the anchor
too, and importing anything under ``explabs.api`` executes the API package's
``__init__`` (which builds the app), closing an import cycle back through the
engine. Keep this module import-free of the rest of explabs.

The Telemetry page shows, next to each request's real cost, what the same
tokens would have cost at a frontier model's published list price. The anchor
is Claude Fable 5 (platform.claude.com pricing, read 2026-07): $10 per
million input tokens, $50 per million output tokens, cache reads at roughly
one tenth of the input price. One constant set, server-side, so the frontend
never does cost math (spend-number seam with the settings surface).

This is a comparison figure computed from public list prices, not a metered
charge; real per-request cost stays ``cost_usd`` on the serving-request row.
"""

from __future__ import annotations

FRONTIER_MODEL_LABEL = "Claude Fable 5"

# Published so every other anchor mention derives from this one set
# (engine/seed_report.py; apps/web/lib/money.ts mirrors it with a pinned test
# that reads THIS file).
INPUT_USD_PER_MTOK = 10.0
CACHED_INPUT_USD_PER_MTOK = 1.0
OUTPUT_USD_PER_MTOK = 50.0


def frontier_cost_usd(*, input_tokens: int, output_tokens: int, cached_tokens: int = 0) -> float:
    """Price a request's tokens at the frontier anchor's list price.

    Args:
        input_tokens: Total input tokens, including any cached portion.
        output_tokens: Output tokens.
        cached_tokens: Portion of the input served from a prompt cache,
            billed at the cache-read rate.

    Returns:
        The list-price cost in USD.
    """
    cached = min(max(cached_tokens, 0), max(input_tokens, 0))
    uncached = max(input_tokens, 0) - cached
    return (
        uncached * INPUT_USD_PER_MTOK
        + cached * CACHED_INPUT_USD_PER_MTOK
        + max(output_tokens, 0) * OUTPUT_USD_PER_MTOK
    ) / 1_000_000
