# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Read and write the historical imported-usage attribution store.

``gateway_imported_usage`` holds per-turn usage METADATA a tenant imported from
their local Codex / Claude Code logs (see
``20260820103000_gateway_usage_import.sql``). It is deliberately separate from
``gateway_usage_events``: imported rows are historical attribution, never
charged and never reconciled against credits.

Writes are idempotent per ``(org_id, record_hash)``: replaying an
import inserts nothing new, so a founder's agent can re-run it safely. Reads
aggregate per ``(source, model)`` via the ``gateway_imported_usage_by_model``
RPC so the Logs page never pages every imported turn through PostgREST.
Import deduplication still pages ``record_hash`` values. Money stays integer
micro-USD; the API boundary converts for display.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import JsonObject, SupabaseClient, result_rows


class ImportSource(StrEnum):
    """The local tool an imported usage record came from."""

    CODEX = "codex"
    CLAUDE_CODE = "claude-code"


class ImportedUsageWrite(BaseModel):
    """One priced, mapped usage record ready to persist.

    Identity is ``(org_id, record_hash)``; ``alias``/``provider`` are the
    catalog mapping (both ``None`` when ``model_matched`` is false). Money is
    attribution-only integer micro-USD (never charged).
    """

    model_config = ConfigDict(frozen=True)

    record_hash: str
    source: ImportSource
    raw_model: str
    alias: str | None
    provider: str | None
    model_matched: bool
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int
    reasoning_tokens: int
    estimated_cost_micro_usd: int
    occurred_at: str
    day: str


class ImportOutcome(BaseModel):
    """The result of persisting one batch.

    ``inserted`` are turns new to the org; ``duplicates`` were already present
    and were overwritten in place (a re-import corrects a turn's mapping without
    double-counting), so a replayed batch reports ``inserted == 0``.
    """

    model_config = ConfigDict(frozen=True)

    received: int
    inserted: int
    duplicates: int


class ImportedModelRollup(BaseModel):
    """Aggregated imported usage for one (source, model) pair.

    ``model`` is the catalog alias when matched, else the raw log string.
    ``request_count`` is the number of imported turns. Cost is attribution-only.
    """

    model_config = ConfigDict(frozen=True)

    source: ImportSource
    model: str
    model_matched: bool
    request_count: int
    input_tokens: int
    output_tokens: int
    cached_input_tokens: int
    reasoning_tokens: int
    estimated_cost_micro_usd: int


def _int(value: object) -> int:
    """Coerce a stored numeric to int, treating null as zero."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int | float):
        return int(value)
    return 0


class GatewayImportedUsageStore:
    """Persist and aggregate a tenant's imported historical usage."""

    def __init__(self, client: SupabaseClient) -> None:
        """Initialize the store.

        Args:
            client: Service-role Supabase client.
        """
        self._client = client

    def record_batch(
        self,
        org_id: str,
        *,
        user_id: str | None,
        batch_id: str,
        records: tuple[ImportedUsageWrite, ...],
    ) -> ImportOutcome:
        """Persist a batch, overwriting turns already imported for the org.

        Identity is ``(org_id, record_hash)`` — NOT batch-scoped — so a turn
        that reappears (a retry under a new ``batch_id``, or two overlapping
        export files) never double-counts. Existing turns are overwritten in
        place via ``ON CONFLICT DO UPDATE``, so a re-import corrects their model
        mapping and cost. Repeats within ``records`` collapse to the last one.

        Args:
            org_id: Owning organization.
            user_id: The importing member, or ``None`` (organization-key import).
            batch_id: Provenance identifier for this import run.
            records: Priced, mapped usage records.

        Returns:
            Counts of received, newly inserted, and overwritten (duplicate) rows.
        """
        existing = self._existing_hashes(org_id)
        by_hash: dict[str, dict[str, object]] = {}
        new_count = 0
        for record in records:
            if record.record_hash not in existing and record.record_hash not in by_hash:
                new_count += 1
            by_hash[record.record_hash] = {
                "org_id": org_id,
                "record_hash": record.record_hash,
                "batch_id": batch_id,
                "user_id": user_id,
                "import_source": record.source.value,
                "model_raw": record.raw_model,
                "alias": record.alias,
                "provider": record.provider,
                "model_matched": record.model_matched,
                "input_tokens": record.input_tokens,
                "output_tokens": record.output_tokens,
                "cached_input_tokens": record.cached_input_tokens,
                "reasoning_tokens": record.reasoning_tokens,
                "estimated_cost_micro_usd": record.estimated_cost_micro_usd,
                "occurred_at": record.occurred_at,
                "day": record.day,
            }
        rows = list(by_hash.values())
        if rows:
            # DO UPDATE (not ignore_duplicates): re-importing the same turn
            # overwrites its mapping/cost in place, never inserting a second row.
            self._client.table("gateway_imported_usage_events").upsert(
                rows,
                on_conflict="org_id,record_hash",
            ).execute()
        return ImportOutcome(
            received=len(records),
            inserted=new_count,
            duplicates=len(records) - new_count,
        )

    def _existing_hashes(self, org_id: str) -> set[str]:
        """Return every record hash already stored for an org."""
        return {
            str(row["record_hash"])
            for row in self._all_rows(org_id, "record_hash")
            if row.get("record_hash") is not None
        }

    def _all_rows(self, org_id: str, columns: str) -> list[JsonObject]:
        """Page imported-usage columns for an org past the PostgREST row cap.

        An org can hold far more than PostgREST's 1000-row default (a dry run
        imported 254k turns). Dedup still pages ``record_hash`` values; the
        Logs rollup uses ``gateway_imported_usage_by_model`` instead of this
        path. Ordered by ``record_hash`` (unique within the
        ``(org_id, record_hash)`` key) so paging never skips or repeats a row.
        """
        page_size = 1_000
        offset = 0
        rows: list[JsonObject] = []
        while True:
            result = (
                self._client.table("gateway_imported_usage_events")
                .select(columns)
                .eq("org_id", org_id)
                .order("record_hash")
                .range(offset, offset + page_size - 1)
                .execute()
            )
            page = result_rows(result)
            rows.extend(page)
            if len(page) < page_size:
                break
            offset += page_size
        return rows

    def by_model(self, org_id: str) -> tuple[ImportedModelRollup, ...]:
        """Aggregate all imported usage for an org per (source, model).

        One ``gateway_imported_usage_by_model`` RPC returns the compact rollup.
        Import deduplication still pages hashes through ``_all_rows``; this
        read must not.

        Args:
            org_id: Owning organization.

        Returns:
            One rollup per (source, model), highest attributed spend first,
            then highest request count, then source, model, matched.
        """
        result = self._client.rpc(
            "gateway_imported_usage_by_model",
            {"in_org": org_id},
        ).execute()
        rollups = [
            ImportedModelRollup(
                source=ImportSource(str(row.get("import_source") or "")),
                model=str(row.get("model") or ""),
                model_matched=bool(row.get("model_matched")),
                request_count=_int(row.get("request_count")),
                input_tokens=_int(row.get("input_tokens")),
                output_tokens=_int(row.get("output_tokens")),
                cached_input_tokens=_int(row.get("cached_input_tokens")),
                reasoning_tokens=_int(row.get("reasoning_tokens")),
                estimated_cost_micro_usd=_int(row.get("estimated_cost_micro_usd")),
            )
            for row in result_rows(result)
        ]
        rollups.sort(
            key=lambda rollup: (
                -rollup.estimated_cost_micro_usd,
                -rollup.request_count,
                rollup.source.value,
                rollup.model,
                not rollup.model_matched,
            )
        )
        return tuple(rollups)
