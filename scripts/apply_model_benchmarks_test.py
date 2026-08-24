# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Benchmark data-file validation (pure) and the DB apply (integration).

The integration test needs a migrated, disposable Supabase (``SUPABASE_DB_URL``)
carrying the ``model_benchmarks`` schema; it skips otherwise and cleans up the
``benchitest-`` rows it creates.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from pathlib import Path
from typing import cast

import psycopg
import pytest
from pydantic import ValidationError

from scripts.apply_model_benchmarks import (
    ApplyResult,
    ModelBenchmarkEntry,
    apply_entries,
    load_entries,
)

_SCORE = {
    "benchmark": "mmlu-pro",
    "score": 81.3,
    "source": "vendor",
    "source_url": "https://example.com/model-card",
    "retrieved_at": "2026-08-23T00:00:00Z",
}


def _entry(**overrides: object) -> dict[str, object]:
    entry: dict[str, object] = {
        "model_slug": "glm-6",
        "huggingface_url": "https://huggingface.co/zai-org/GLM-6",
        "release_url": None,
        "benchmarks": [_SCORE],
    }
    entry.update(overrides)
    return entry


def _write(tmp_path: Path, payload: object) -> Path:
    path = tmp_path / "benchmarks.json"
    path.write_text(json.dumps(payload))
    return path


def test_load_entries_accepts_a_valid_file(tmp_path: Path) -> None:
    """The happy path: a registry benchmark with an https citation loads."""
    entries = load_entries(_write(tmp_path, [_entry()]))

    assert entries[0].model_slug == "glm-6"
    assert entries[0].benchmarks[0].score == 81.3


def test_unknown_benchmark_slug_is_a_hard_error(tmp_path: Path) -> None:
    """Scores must key on the registry; a novel eval name needs a registry PR."""
    path = _write(tmp_path, [_entry(benchmarks=[{**_SCORE, "benchmark": "vibe-eval"}])])

    with pytest.raises(ValidationError, match="benchmark_registry"):
        load_entries(path)


def test_unknown_source_is_rejected(tmp_path: Path) -> None:
    """The source vocabulary matches the schema's constrained set exactly."""
    path = _write(tmp_path, [_entry(benchmarks=[{**_SCORE, "source": "artificialanalysis"}])])

    with pytest.raises(ValidationError):
        load_entries(path)


def test_non_https_citation_is_rejected(tmp_path: Path) -> None:
    """Every stored score must carry an https citation URL."""
    path = _write(tmp_path, [_entry(benchmarks=[{**_SCORE, "source_url": "http://x.com"}])])

    with pytest.raises(ValidationError, match="not https"):
        load_entries(path)


def test_huggingface_url_must_be_on_huggingface(tmp_path: Path) -> None:
    """The HF link renders as the official repo; other hosts are rejected."""
    path = _write(tmp_path, [_entry(huggingface_url="https://example.com/repo")])

    with pytest.raises(ValidationError, match=r"huggingface\.co"):
        load_entries(path)


def test_duplicate_model_slugs_are_rejected(tmp_path: Path) -> None:
    """One entry per canonical model keeps merges deterministic."""
    with pytest.raises(ValueError, match="duplicate model slugs"):
        load_entries(_write(tmp_path, [_entry(), _entry()]))


def test_duplicate_benchmarks_within_an_entry_are_rejected(tmp_path: Path) -> None:
    """(model, benchmark) is the upsert key; two scores for it is ambiguous."""
    path = _write(tmp_path, [_entry(benchmarks=[_SCORE, _SCORE])])

    with pytest.raises(ValidationError, match="one score per benchmark"):
        load_entries(path)


def test_empty_file_applies_as_a_no_op(tmp_path: Path) -> None:
    """The shipped store starts empty; seeding must stay green before backfill."""
    assert load_entries(_write(tmp_path, [])) == ()
    # apply_entries never touches the connection for an empty set, so the
    # narrowest possible stand-in proves the short-circuit.
    unreachable = cast("psycopg.Connection[tuple[object, ...]]", None)
    assert apply_entries(unreachable, ()) == ApplyResult(0, 0, ())


# ---------------------------------------------------------------------------
# DB apply (integration).


@pytest.fixture
def connection() -> Iterator[psycopg.Connection[tuple[object, ...]]]:
    """A direct connection to the disposable integration database."""
    database_url = os.environ.get("SUPABASE_DB_URL", "").strip()
    if not database_url:
        pytest.skip("SUPABASE_DB_URL is required for integration tests")
    with psycopg.connect(database_url) as conn:
        yield conn
        conn.execute(
            "delete from public.models where slug like 'benchitest-%' and owning_org_id is null"
        )
        conn.commit()


@pytest.mark.integration
def test_apply_upserts_scores_and_fills_links(
    connection: psycopg.Connection[tuple[object, ...]],
) -> None:
    """Scores upsert on (model_id, benchmark); links never overwrite with null."""
    connection.execute(
        """
        insert into public.models (slug, display_name, release_url)
        values ('benchitest-alpha', 'Bench Itest Alpha', 'https://curated.example/release')
        on conflict (slug, owning_org_id) do nothing
        """
    )
    entry = ModelBenchmarkEntry.model_validate(
        _entry(model_slug="benchitest-alpha", release_url=None)
    )

    first = apply_entries(connection, (entry, entry.model_copy(update={"model_slug": "ghost"})))
    rescored = entry.model_copy(
        update={"benchmarks": (entry.benchmarks[0].model_copy(update={"score": 84.0}),)}
    )
    second = apply_entries(connection, (rescored,))

    assert first.missing_slugs == ("ghost",)
    row = connection.execute(
        """
        select mb.score, m.huggingface_url, m.release_url
        from public.model_benchmarks mb
        join public.models m on m.id = mb.model_id
        where m.slug = 'benchitest-alpha' and mb.benchmark = 'mmlu-pro'
        """
    ).fetchone()
    assert row is not None
    score, huggingface_url, release_url = row
    assert float(str(score)) == 84.0
    assert huggingface_url == "https://huggingface.co/zai-org/GLM-6"
    # A null incoming release_url must not clobber the curated one.
    assert release_url == "https://curated.example/release"
    assert second.scores_upserted == 1
