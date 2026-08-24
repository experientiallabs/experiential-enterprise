# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Contracts for the benchmark registry every ingestion path validates against."""

import pytest

from explabs.gateway.benchmark_registry import (
    BENCHMARK_SLUG_PATTERN,
    BENCHMARK_SOURCES,
    KNOWN_BENCHMARKS,
    BenchmarkSpec,
    _registry,
)


def test_every_registered_slug_is_storable() -> None:
    """Registry slugs must satisfy the model_benchmarks.benchmark slug check."""
    for slug, spec in KNOWN_BENCHMARKS.items():
        assert slug == spec.slug
        assert BENCHMARK_SLUG_PATTERN.fullmatch(slug), slug


def test_units_and_directions_are_sane() -> None:
    """Elo is the arena's unit; everything else reads as percent or points."""
    assert KNOWN_BENCHMARKS["lmarena-elo"].unit == "elo"
    assert KNOWN_BENCHMARKS["mmlu-pro"].unit == "percent"
    assert all(spec.higher_is_better for spec in KNOWN_BENCHMARKS.values())


def test_registry_refuses_duplicate_slugs() -> None:
    """Two specs with one slug is a programming error, caught at import."""
    spec = BenchmarkSpec("mmlu", "MMLU", "percent")
    with pytest.raises(ValueError, match="duplicate"):
        _registry(spec, spec)


def test_registry_refuses_malformed_slugs() -> None:
    """Slugs must satisfy the storable slug pattern."""
    with pytest.raises(ValueError, match="slug pattern"):
        _registry(BenchmarkSpec("MMLU Pro", "MMLU-Pro", "percent"))


def test_source_vocabulary_matches_the_schema_check() -> None:
    """The apply lane's source values are exactly the schema's constrained set."""
    assert {"vendor", "huggingface", "lmarena", "leaderboard", "paper"} == BENCHMARK_SOURCES
