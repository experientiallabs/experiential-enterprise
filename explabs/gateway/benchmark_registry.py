# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The registry of public benchmarks the catalog carries scores for.

``public.model_benchmarks`` stores one row per (model, benchmark) with score
and provenance; the DATABASE deliberately knows nothing about a benchmark
beyond its slug. Everything display- or validation-shaped about a benchmark —
its human name, score unit, and direction — lives here, in one code-side
registry, so adding a benchmark is one dict entry and never a migration.

Every ingestion path (the daily catalog sync's Codex judgments, the one-time
backfill, and ``scripts/apply_model_benchmarks.py``) validates candidate rows
against :data:`KNOWN_BENCHMARKS`: an unknown benchmark slug is rejected loudly,
which forces new benchmarks to be added here deliberately instead of letting
749 models accumulate 749 spellings of the same eval.

Scores come only from publicly reusable sources (vendor model cards/blogs,
papers, Hugging Face model pages and leaderboards, LMArena's CC-BY-4.0
leaderboard dataset). Artificial Analysis is deliberately absent: its API
tiers license internal use only, and this data renders on public pages.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

# Mirrors the public.models slug check; model_benchmarks.benchmark uses the
# same shape so a registry slug is always storable as-is.
BENCHMARK_SLUG_PATTERN = re.compile(r"^[a-z][a-z0-9._-]{0,127}$")

# The provenance vocabulary of model_benchmarks.source (constrained in the
# schema the way stats_source is; widen additively, never free-text).
BENCHMARK_SOURCES: frozenset[str] = frozenset(
    {"vendor", "huggingface", "lmarena", "leaderboard", "paper"}
)

ScoreUnit = Literal["percent", "elo", "points"]


@dataclass(frozen=True)
class BenchmarkSpec:
    """One benchmark the catalog understands.

    Attributes:
        slug: Stable key, stored in ``model_benchmarks.benchmark``.
        display_name: Human name rendered by the model and compare pages.
        unit: How to read the score — ``percent`` (0-100 accuracy-like),
            ``elo`` (arena rating), or ``points`` (benchmark-native scale).
        higher_is_better: Comparison direction for best-value highlighting.
    """

    slug: str
    display_name: str
    unit: ScoreUnit
    higher_is_better: bool = True


def _registry(*specs: BenchmarkSpec) -> dict[str, BenchmarkSpec]:
    """Key specs by slug, refusing duplicates and malformed slugs."""
    registry: dict[str, BenchmarkSpec] = {}
    for spec in specs:
        if not BENCHMARK_SLUG_PATTERN.fullmatch(spec.slug):
            message = f"benchmark slug {spec.slug!r} violates the slug pattern"
            raise ValueError(message)
        if spec.slug in registry:
            message = f"duplicate benchmark slug {spec.slug!r}"
            raise ValueError(message)
        registry[spec.slug] = spec
    return registry


KNOWN_BENCHMARKS: dict[str, BenchmarkSpec] = _registry(
    BenchmarkSpec("mmlu", "MMLU", "percent"),
    BenchmarkSpec("mmlu-pro", "MMLU-Pro", "percent"),
    BenchmarkSpec("gpqa-diamond", "GPQA Diamond", "percent"),
    BenchmarkSpec("swe-bench-verified", "SWE-bench Verified", "percent"),
    BenchmarkSpec("livebench", "LiveBench", "percent"),
    BenchmarkSpec("aime-2025", "AIME 2025", "percent"),
    BenchmarkSpec("aime-2026", "AIME 2026", "percent"),
    BenchmarkSpec("hle", "Humanity's Last Exam", "percent"),
    BenchmarkSpec("math-500", "MATH-500", "percent"),
    BenchmarkSpec("mmmu", "MMMU", "percent"),
    BenchmarkSpec("ifeval", "IFEval", "percent"),
    BenchmarkSpec("lmarena-elo", "LMArena Elo", "elo"),
    BenchmarkSpec("terminal-bench", "Terminal-Bench", "points"),
)
