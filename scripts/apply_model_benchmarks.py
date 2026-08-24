# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Apply the committed model-benchmark data to a catalog database.

``supabase/seed-model-benchmarks.json`` is the single committed source of truth
for public-model benchmark scores and Hugging Face / official-release links:
one entry per canonical model slug, each score carrying provenance (source,
citation URL, retrieved timestamp). It is written only through reviewed PRs —
by the one-time backfill and by the daily catalog sync's Codex judgments — and
never guessed: low-confidence findings live in
``supabase/seed-model-benchmarks.unsure.json`` awaiting human review and are
NEVER applied to a database.

This script is the one writer that moves that data into
``public.model_benchmarks`` / ``public.models``. It runs in every environment
the same way (migrations never insert catalog data in this repo):

- local / preview: invoked by ``scripts/seed_supabase_local.sh`` and
  ``scripts/preview/seed_supabase_branch.sh`` after the catalog seed;
- production: a step in ``.github/workflows/catalog-sync.yml`` (the 07:00 UTC
  scheduled catalog refresh), so merged data lands in prod within a day, or on
  a manual dispatch of that workflow.

Idempotent and non-destructive: scores upsert on ``(model_id, benchmark)``;
``models.huggingface_url`` / ``models.release_url`` are only overwritten by a
non-null incoming value. A slug the database does not carry is reported, not
fatal — a local DB seeds ~67 models while production carries hundreds.

    SUPABASE_DB_URL=postgres://... uv run python scripts/apply_model_benchmarks.py
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import psycopg
from pydantic import BaseModel, ConfigDict, field_validator

from explabs.gateway.benchmark_registry import KNOWN_BENCHMARKS

_REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = _REPO_ROOT / "supabase" / "seed-model-benchmarks.json"
UNSURE_PATH = _REPO_ROOT / "supabase" / "seed-model-benchmarks.unsure.json"

Connection = psycopg.Connection[tuple[object, ...]]


class BenchmarkScore(BaseModel):
    """One benchmark score with its provenance, as stored in the data file."""

    model_config = ConfigDict(frozen=True)

    benchmark: str
    score: float
    source: Literal["vendor", "huggingface", "lmarena", "leaderboard", "paper"]
    source_url: str
    retrieved_at: dt.datetime

    @field_validator("benchmark")
    @classmethod
    def _known_benchmark(cls, value: str) -> str:
        if value not in KNOWN_BENCHMARKS:
            message = (
                f"unknown benchmark {value!r}; add it to "
                "explabs/gateway/benchmark_registry.py first"
            )
            raise ValueError(message)
        return value

    @field_validator("score")
    @classmethod
    def _non_negative(cls, value: float) -> float:
        if value < 0:
            message = f"score {value} is negative"
            raise ValueError(message)
        return value

    @field_validator("source_url")
    @classmethod
    def _https(cls, value: str) -> str:
        if not value.startswith("https://"):
            message = f"source_url {value!r} is not https"
            raise ValueError(message)
        return value


class ModelBenchmarkEntry(BaseModel):
    """Benchmarks and release links for one canonical (public) model slug."""

    model_config = ConfigDict(frozen=True, protected_namespaces=())

    model_slug: str
    huggingface_url: str | None = None
    release_url: str | None = None
    benchmarks: tuple[BenchmarkScore, ...] = ()

    @field_validator("huggingface_url")
    @classmethod
    def _hf_host(cls, value: str | None) -> str | None:
        if value is not None and not value.startswith("https://huggingface.co/"):
            message = f"huggingface_url {value!r} is not a huggingface.co URL"
            raise ValueError(message)
        return value

    @field_validator("release_url")
    @classmethod
    def _https(cls, value: str | None) -> str | None:
        if value is not None and not value.startswith("https://"):
            message = f"release_url {value!r} is not https"
            raise ValueError(message)
        return value

    @field_validator("benchmarks")
    @classmethod
    def _one_score_per_benchmark(
        cls, value: tuple[BenchmarkScore, ...]
    ) -> tuple[BenchmarkScore, ...]:
        slugs = [score.benchmark for score in value]
        if len(slugs) != len(set(slugs)):
            message = "an entry may carry at most one score per benchmark"
            raise ValueError(message)
        return value


def load_entries(path: Path) -> tuple[ModelBenchmarkEntry, ...]:
    """Parse and validate the committed data file (one entry per model slug)."""
    raw = json.loads(path.read_text())
    if not isinstance(raw, list):
        message = f"{path} must carry a JSON list of entries"
        raise TypeError(message)
    entries = tuple(ModelBenchmarkEntry.model_validate(item) for item in raw)
    slugs = [entry.model_slug for entry in entries]
    duplicates = sorted({slug for slug in slugs if slugs.count(slug) > 1})
    if duplicates:
        message = f"duplicate model slugs in {path}: {', '.join(duplicates)}"
        raise ValueError(message)
    return entries


@dataclass(frozen=True)
class ApplyResult:
    """Outcome of one apply run."""

    models_updated: int
    scores_upserted: int
    missing_slugs: tuple[str, ...]


def apply_entries(connection: Connection, entries: tuple[ModelBenchmarkEntry, ...]) -> ApplyResult:
    """Upsert benchmark scores and release links for every present slug, one txn.

    Args:
        connection: Direct Postgres connection with service authority.
        entries: Validated data-file entries.

    Returns:
        Counts plus the slugs the target database does not carry (reported,
        never fatal — smaller environments seed a subset of the catalog).
    """
    if not entries:
        return ApplyResult(0, 0, ())
    slugs = [entry.model_slug for entry in entries]
    with connection.transaction():
        rows = connection.execute(
            "select slug, id from public.models where owning_org_id is null and slug = any(%s)",
            (slugs,),
        ).fetchall()
        ids_by_slug = {str(slug): str(model_id) for slug, model_id in rows}

        models_updated = 0
        scores_upserted = 0
        for entry in entries:
            model_id = ids_by_slug.get(entry.model_slug)
            if model_id is None:
                continue
            if entry.huggingface_url is not None or entry.release_url is not None:
                connection.execute(
                    """
                    update public.models set
                        huggingface_url = coalesce(%s, huggingface_url),
                        release_url = coalesce(%s, release_url)
                    where id = %s
                    """,
                    (entry.huggingface_url, entry.release_url, model_id),
                )
                models_updated += 1
            for score in entry.benchmarks:
                connection.execute(
                    """
                    insert into public.model_benchmarks (
                        model_id, benchmark, score, source, source_url, retrieved_at
                    )
                    values (%s, %s, %s, %s, %s, %s)
                    on conflict (model_id, benchmark) do update set
                        score = excluded.score,
                        source = excluded.source,
                        source_url = excluded.source_url,
                        retrieved_at = excluded.retrieved_at,
                        updated_at = now()
                    """,
                    (
                        model_id,
                        score.benchmark,
                        score.score,
                        score.source,
                        score.source_url,
                        score.retrieved_at,
                    ),
                )
                scores_upserted += 1

    missing = tuple(slug for slug in slugs if slug not in ids_by_slug)
    return ApplyResult(models_updated, scores_upserted, missing)


def main() -> int:
    """Validate the committed data and apply it to ``SUPABASE_DB_URL``."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DATA_PATH, help="benchmark data file to apply")
    parser.add_argument(
        "--database-url",
        default=None,
        help="target database (defaults to SUPABASE_DB_URL)",
    )
    args = parser.parse_args()

    entries = load_entries(args.data)
    if not entries:
        print(f"{args.data.name}: no entries yet; nothing to apply")
        return 0

    database_url = (args.database_url or os.environ.get("SUPABASE_DB_URL", "")).strip()
    if not database_url:
        print("SUPABASE_DB_URL must point at the target database", file=sys.stderr)
        return 2

    with psycopg.connect(database_url) as connection:
        result = apply_entries(connection, entries)

    print(
        f"model benchmarks applied: {result.scores_upserted} score(s) across "
        f"{len(entries) - len(result.missing_slugs)} model(s); "
        f"{result.models_updated} model row(s) took release links"
    )
    if result.missing_slugs:
        print(
            f"absent from this database ({len(result.missing_slugs)}; normal outside prod): "
            + ", ".join(result.missing_slugs[:20])
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
