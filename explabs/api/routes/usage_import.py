# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Historical AI-spend import: bootstrap a fresh dashboard with real usage.

The onboarding "attribute your existing AI spend" flow. A founder's agent
parses their LOCAL Codex and Claude Code session logs — METADATA ONLY: model
id and per-turn token counts, never any message content — and POSTs the
aggregated per-turn usage to ``POST /api/gateway/usage/import`` with their
organization API key. Each record is mapped to a launch-catalog model, priced
from the catalog list price, and written to ``gateway_imported_usage`` as
HISTORICAL ATTRIBUTION: a lane distinct from gateway-served usage, never
charged and never deducted from credits.

The batch is idempotent: the endpoint hashes each record's identity so
re-running an import (same ``batch_id``) inserts nothing new. Unknown models do
not fail the batch — they are recorded with zero cost and flagged, so the
tenant sees the traffic even when the model is outside the catalog.

``GET /api/orgs/{org_id}/usage/imported`` reads the per-(source, model)
attribution back for the Telemetry page's "Imported" breakdown.
"""

from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.routes import ApiError, get_supabase
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import SupabaseClient
from explabs.db.stores.gateway_imported_usage_store import (
    GatewayImportedUsageStore,
    ImportedModelRollup,
    ImportedUsageWrite,
    ImportSource,
)
from explabs.usage_import_catalog import price_usage

router = APIRouter(prefix="/api", tags=["usage"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]

# A generous ceiling on one import batch. A founder's whole local history is
# well within this; a larger corpus imports as several batches.
_MAX_BATCH_RECORDS = 10_000


def _micro_to_usd(cost_micro_usd: int) -> float:
    """Convert integer micro-USD to display dollars."""
    return cost_micro_usd / 1_000_000


class ImportUsageRecordInput(BaseModel):
    """One imported per-turn usage record — metadata only, never content.

    Token counts follow one normalized convention across sources so pricing is
    uniform: ``input_tokens`` is fresh (non-cached) input, ``cached_tokens`` is
    cached input, ``output_tokens`` includes reasoning, and
    ``reasoning_tokens`` is the reasoning subset carried for display.
    """

    model_config = ConfigDict(frozen=True)

    model: str = Field(min_length=1, max_length=256)
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    cached_tokens: int = Field(default=0, ge=0)
    reasoning_tokens: int = Field(default=0, ge=0)
    timestamp: str
    source: ImportSource
    # The log's native, stable per-turn id (Claude Code message id, Codex
    # session+turn ordinal). Folded into the dedupe hash so two genuinely
    # distinct calls that happen to share a timestamp and token counts stay
    # distinct. Optional: absent ids fall back to the metadata tuple.
    event_id: str | None = Field(default=None, max_length=256)


class ImportUsageRequest(BaseModel):
    """A batch of historical usage records to attribute to an organization.

    ``batch_id`` groups the import run and makes it idempotent. ``org_id`` is
    honored only for platform-admin callers; an organization API key always
    imports into its own organization.
    """

    model_config = ConfigDict(frozen=True)

    batch_id: str = Field(min_length=1, max_length=200)
    records: tuple[ImportUsageRecordInput, ...]
    org_id: str | None = None


class ImportedModelSpend(BaseModel):
    """One (source, model) row of imported historical attribution.

    ``cost_usd`` is attribution only — historical spend the tenant already
    paid their provider, never charged here and never deducted from credits.
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
    cost_usd: float


class ImportedUsageTotals(BaseModel):
    """Window-free totals across all imported historical usage."""

    model_config = ConfigDict(frozen=True)

    request_count: int
    input_tokens: int
    output_tokens: int
    cost_usd: float


class ImportUsageResponse(BaseModel):
    """The outcome of one import batch plus the resulting attribution."""

    model_config = ConfigDict(frozen=True)

    batch_id: str
    received: int
    imported: int
    duplicates: int
    unmatched_models: tuple[str, ...]
    by_model: tuple[ImportedModelSpend, ...]
    totals: ImportedUsageTotals


class ImportedUsageResponse(BaseModel):
    """The Telemetry page's imported-usage breakdown for an org."""

    model_config = ConfigDict(frozen=True)

    models: tuple[ImportedModelSpend, ...]
    totals: ImportedUsageTotals


def _require_viewer(client: SupabaseClient, actor: RequestActor, org_id: str) -> None:
    """Gate a read on org membership."""
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.USER,
        not_found=f"Organization not found: {org_id}",
    )


def _resolve_import_org(actor: RequestActor, body: ImportUsageRequest) -> str:
    """Resolve which organization a batch imports into.

    An organization API key imports into its own organization; the key IS the
    org, so a caller can never write across orgs. A platform admin may target
    any organization via ``org_id`` (used for dogfooding and tests). Every
    other caller is rejected. A malformed org id fails at the database's typed
    boundary (uuid + the org foreign key), not with a guessed format here.
    """
    if actor.api_key_org_id is not None:
        return actor.api_key_org_id
    if actor.is_platform_admin and body.org_id is not None:
        return body.org_id
    msg = "Usage import requires an organization API key"
    raise ApiError(msg, status_code=403)


def _event_time(timestamp: str) -> datetime:
    """Parse an ISO 8601 turn timestamp to an aware UTC datetime."""
    normalized = timestamp.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        msg = f"Invalid timestamp: {timestamp} (expected an ISO 8601 timestamp)"
        raise ApiError(msg, status_code=400) from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _record_hash(record: ImportUsageRecordInput) -> str:
    """Hash a record's identity so a replayed batch dedupes deterministically.

    The hash covers only usage metadata — source, model, timestamp, and token
    counts — never any content, because no content is ever received.
    """
    identity = "|".join(
        (
            record.source.value,
            record.event_id or "",
            record.model,
            record.timestamp,
            str(record.input_tokens),
            str(record.output_tokens),
            str(record.cached_tokens),
            str(record.reasoning_tokens),
        )
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _price_records(
    records: tuple[ImportUsageRecordInput, ...],
) -> tuple[tuple[ImportedUsageWrite, ...], tuple[str, ...]]:
    """Map and price a batch, returning writes and the unmatched model set."""
    writes: list[ImportedUsageWrite] = []
    unmatched: list[str] = []
    for record in records:
        event_at = _event_time(record.timestamp)
        priced = price_usage(
            record.model,
            input_tokens=record.input_tokens,
            cached_input_tokens=record.cached_tokens,
            output_tokens=record.output_tokens,
        )
        if not priced.model.matched and record.model not in unmatched:
            unmatched.append(record.model)
        writes.append(
            ImportedUsageWrite(
                record_hash=_record_hash(record),
                source=record.source,
                raw_model=record.model,
                alias=priced.model.alias,
                provider=priced.model.provider,
                model_matched=priced.model.matched,
                input_tokens=record.input_tokens,
                output_tokens=record.output_tokens,
                cached_input_tokens=record.cached_tokens,
                reasoning_tokens=record.reasoning_tokens,
                estimated_cost_micro_usd=priced.cost_micro_usd,
                occurred_at=event_at.isoformat(),
                day=event_at.date().isoformat(),
            )
        )
    return tuple(writes), tuple(unmatched)


def _spend_view(rollup: ImportedModelRollup) -> ImportedModelSpend:
    """Project a store rollup into the API spend row."""
    return ImportedModelSpend(
        source=rollup.source,
        model=rollup.model,
        model_matched=rollup.model_matched,
        request_count=rollup.request_count,
        input_tokens=rollup.input_tokens,
        output_tokens=rollup.output_tokens,
        cached_input_tokens=rollup.cached_input_tokens,
        reasoning_tokens=rollup.reasoning_tokens,
        cost_usd=_micro_to_usd(rollup.estimated_cost_micro_usd),
    )


def _totals(rollups: tuple[ImportedModelRollup, ...]) -> ImportedUsageTotals:
    """Sum a set of rollups into window-free totals."""
    return ImportedUsageTotals(
        request_count=sum(rollup.request_count for rollup in rollups),
        input_tokens=sum(rollup.input_tokens for rollup in rollups),
        output_tokens=sum(rollup.output_tokens for rollup in rollups),
        cost_usd=_micro_to_usd(sum(rollup.estimated_cost_micro_usd for rollup in rollups)),
    )


@router.post("/gateway/usage/import", status_code=201)
async def import_usage(
    body: ImportUsageRequest,
    client: Client,
    actor: Actor,
) -> ImportUsageResponse:
    """Attribute a batch of historical local usage to the caller's org.

    Metadata only: the batch carries per-turn model and token counts, never
    message content. Records map to catalog models and are priced as historical
    attribution — never charged, never deducted from credits. Idempotent per
    ``batch_id`` + record identity; unknown models are recorded at zero cost
    rather than failing the batch.
    """
    org_id = _resolve_import_org(actor, body)
    if not body.records:
        msg = "Import batch has no records"
        raise ApiError(msg, status_code=400)
    if len(body.records) > _MAX_BATCH_RECORDS:
        msg = f"Import batch exceeds {_MAX_BATCH_RECORDS} records; split it"
        raise ApiError(msg, status_code=400)
    writes, unmatched = _price_records(body.records)
    store = GatewayImportedUsageStore(client)
    outcome = await asyncio.to_thread(
        store.record_batch,
        org_id,
        # A key-authenticated import carries no end user; a platform-admin
        # import records the admin who ran it (the F1 attribution fix).
        user_id=None if actor.api_key_org_id is not None else actor.user_id,
        batch_id=body.batch_id,
        records=writes,
    )
    rollups = await asyncio.to_thread(store.by_model, org_id)
    await asyncio.to_thread(
        record_audit_event,
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.USAGE_IMPORT,
        object_type="usage_import_batch",
        object_id=body.batch_id,
        after={
            "received": outcome.received,
            "imported": outcome.inserted,
            "duplicates": outcome.duplicates,
        },
    )
    return ImportUsageResponse(
        batch_id=body.batch_id,
        received=outcome.received,
        imported=outcome.inserted,
        duplicates=outcome.duplicates,
        unmatched_models=unmatched,
        by_model=tuple(_spend_view(rollup) for rollup in rollups),
        totals=_totals(rollups),
    )


@router.get("/orgs/{org_id}/usage/imported")
async def get_imported_usage(
    org_id: str,
    client: Client,
    actor: Actor,
) -> ImportedUsageResponse:
    """Read an org's imported historical attribution per (source, model)."""
    await asyncio.to_thread(_require_viewer, client, actor, org_id)
    rollups = await asyncio.to_thread(GatewayImportedUsageStore(client).by_model, org_id)
    return ImportedUsageResponse(
        models=tuple(_spend_view(rollup) for rollup in rollups),
        totals=_totals(rollups),
    )
