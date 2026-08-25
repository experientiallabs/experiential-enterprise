# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Gateway models management API: catalog reads and model/waterfall writes.

The launch surface for the gateway catalog (`models`, `model_providers`,
`model_waterfalls`), mounted on the control/all API role:

* Catalog reads (`GET /api/models*`) render without an actor: anonymous
  callers see the public catalog, an identified caller additionally sees the
  rows its organizations own.
* Writes (`POST /api/models`, `POST /api/models/{slug}/providers`,
  `GET/PUT /api/models/{slug}/waterfall`) require an actor per the platform's
  tenancy contract: a customer API key acts for exactly its organization, a
  session actor names the organization explicitly, and platform admins may
  pass ``org_id: null`` to manage the public catalog (rows for the data-fill
  fan-out, default chains).

Customer-key access (Contract 3): these routes must be admitted by the
``_CUSTOMER_KEY_ROUTES`` allowlist in ``explabs/api/app.py``, which the
platform-gateway-integration workstream owns. Until it adds entries for
``GET|POST /api/models``, ``GET|POST /api/models/{slug}/providers``, and
``GET|PUT /api/models/{slug}/waterfall``, an ``xpl_`` key answers 401 at the
middleware and only deployment-key (web/session) callers reach these handlers.
Flagged here rather than edited: that file is the integration workstream's.

Catalog snapshot regeneration: the gateway's catalog builder (integration
workstream, ``explabs/gateway/catalog.py``) rebuilds frozen snapshots from a
15-second poll over these tables, keyed on row timestamps. These routes
therefore never trigger a rebuild themselves; inserts carry fresh timestamps
and the schema's ``set_updated_at`` triggers keep updates honest. The one
write invisible to row timestamps — a waterfall PUT that only deletes rungs —
touches the parent ``models`` row so the poll still observes it.
"""

from __future__ import annotations

import datetime
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from postgrest.exceptions import APIError as PostgrestAPIError
from pydantic import BaseModel, ConfigDict, Field, field_validator

from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.routes.model_stats import fetch_observed_stats, overlay_deployment_row
from explabs.api.tenancy import (
    ACTOR_HEADER,
    OrgRole,
    RequestActor,
    actor_org_ids,
    get_request_actor,
    require_org_role,
)
from explabs.db.repositories import (
    DeleteCapableQuery,
    JsonObject,
    SupabaseClient,
    SupabaseQueryBuilder,
    find_one_by_columns,
    result_rows,
)
from explabs.gateway.benchmark_registry import KNOWN_BENCHMARKS
from explabs.gateway.experiential_cloud import PROVIDER as EXPERIENTIAL_CLOUD_PROVIDER
from explabs.gateway.experiential_cloud import PROVIDER_DESCRIPTION

router = APIRouter(prefix="/api", tags=["models"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]

# Mirrors of the schema's vocabularies (core-P1 migration); the database
# constraints stay authoritative, these exist for self-correcting 422s ahead
# of a round-trip.
_MODALITIES = ("text", "image", "audio", "video", "pdf")
_PROVIDERS = (
    "openai",
    "anthropic",
    "gemini",
    "azure_openai",
    "openrouter",
    "bedrock",
    "local",
    "fireworks",
    "modal",
    "experiential_cloud",
)
# Letter-first: the slug becomes the gateway alias, which WMO types with a
# letter-first pattern, so a digit-first slug could never be called.
_SLUG_PATTERN = r"^[a-z][a-z0-9._-]{0,127}$"
# The schema's explicit endpoint grammar (models catalog migration): scheme,
# host (name/IPv4 or a closed bracketed IPv6 literal), optional port 1..65535,
# optional path; userinfo/query/fragment are forbidden outright.
_BASE_URL_REGEX = re.compile(
    r"^https?://([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])"
    r"(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?"
    r"(/[A-Za-z0-9._~%/-]*)?$"
)
_BASE_URL_MAX_LENGTH = 2048
# Providers whose deployments address a per-row endpoint; every other
# provider has a fixed origin and must not carry one.
_BASE_URL_PROVIDERS = frozenset({"local", "modal"})
# Native vLLM may use a per-row origin or the worker-shared origin.
_OPTIONAL_BASE_URL_PROVIDERS = frozenset({"experiential_cloud"})

# Postgres error codes surfaced through PostgREST. 23514 carries the schema's
# tenancy-guard and check messages, which are written to be shown verbatim.
_UNIQUE_VIOLATION = "23505"
_FK_VIOLATION = "23503"
_CHECK_VIOLATION = "23514"

# Columns that never participate in idempotent-replay comparison: they change
# with every write.
_VOLATILE_COLUMNS = frozenset({"created_at", "updated_at", "pricing_effective_at"})

_POSTGREST_PAGE_SIZE = 1000

ModelSort = Literal["preferred", "price", "age", "context", "throughput"]
SortOrder = Literal["asc", "desc"]


def _utc_now_iso() -> str:
    """Current UTC time as an ISO-8601 string for explicit row timestamps."""
    return datetime.datetime.now(tz=datetime.UTC).isoformat()


# ---------------------------------------------------------------------------
# Request bodies


class DeploymentCreate(BaseModel):
    """One way to reach a model: provider + wire id + optional org scoping.

    ``billing_source`` is deliberately not accepted: rows created through this
    API are always ``customer_managed``; the platform-funded lane
    (``host_managed``) is seeded by operations, never self-asserted.
    """

    model_config = ConfigDict(extra="forbid")

    provider: Literal[
        "openai",
        "anthropic",
        "gemini",
        "azure_openai",
        "openrouter",
        "bedrock",
        "local",
        "fireworks",
        "modal",
        "experiential_cloud",
    ]
    provider_model_id: str = Field(min_length=1, max_length=256)
    base_url: str | None = Field(default=None, max_length=_BASE_URL_MAX_LENGTH)
    region: str | None = Field(default=None, max_length=64)
    api_version: str | None = Field(default=None, max_length=64)
    # Pin to one of the owning org's BYOK connections; null resolves by
    # org + provider at request time.
    provider_connection_id: str | None = None
    # Integer micro-USD per million tokens; null = unknown, never zero.
    input_micro_usd_per_million: int | None = Field(default=None, ge=0)
    cached_input_micro_usd_per_million: int | None = Field(default=None, ge=0)
    output_micro_usd_per_million: int | None = Field(default=None, ge=0)
    reasoning_micro_usd_per_million: int | None = Field(default=None, ge=0)
    pricing_source: str | None = Field(default=None, max_length=64)
    capabilities: JsonObject = Field(default_factory=dict)
    # Catalog stats; the data-fill fan-out imports OpenRouter-labeled values.
    uptime_30d: float | None = Field(default=None, ge=0, le=100)
    throughput_tps: float | None = Field(default=None, ge=0)
    latency_p50_ms: float | None = Field(default=None, ge=0)
    stats_source: Literal["openrouter", "observed", "estimate"] | None = None

    @field_validator("base_url")
    @classmethod
    def _valid_base_url(cls, value: str | None) -> str | None:
        """Mirror the schema's base_url grammar for a pre-flight 422."""
        if value is not None and _BASE_URL_REGEX.match(value) is None:
            msg = (
                "base_url must be an explicit http(s) endpoint "
                "(host, optional port, optional path; no userinfo, query, or "
                "fragment), e.g. https://your-host:8000/v1"
            )
            raise ValueError(msg)
        return value


def _validated_modalities(value: tuple[str, ...]) -> tuple[str, ...]:
    """Mirror the schema's modality vocabulary check."""
    if not value:
        msg = f"modalities must not be empty; allowed values: {', '.join(_MODALITIES)}"
        raise ValueError(msg)
    unknown = [modality for modality in value if modality not in _MODALITIES]
    if unknown:
        msg = f"unknown modalities {unknown!r}; allowed values: {', '.join(_MODALITIES)}"
        raise ValueError(msg)
    return value


class ModelCreate(BaseModel):
    """A custom model: one catalog row plus at least one deployment."""

    model_config = ConfigDict(extra="forbid")

    # Required for session actors; a customer API key implies its org and a
    # platform admin may pass null to create a public catalog row.
    org_id: str | None = None
    slug: str = Field(pattern=_SLUG_PATTERN)
    display_name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    release_date: datetime.date | None = None
    context_window: int | None = Field(default=None, ge=1)
    max_output_tokens: int | None = Field(default=None, ge=1)
    input_modalities: tuple[str, ...] = ("text",)
    output_modalities: tuple[str, ...] = ("text",)
    supported_params: JsonObject = Field(default_factory=dict)
    category: str | None = Field(default=None, max_length=64)
    tags: tuple[str, ...] = ()
    # No preferred_rank here (extra=forbid rejects it): the recommended band
    # is managed WHOLE-SET via PUT /api/admin/recommended-models, never at
    # model creation, so a create cannot race the atomic band replace.
    providers: tuple[DeploymentCreate, ...] = Field(min_length=1)

    @field_validator("display_name")
    @classmethod
    def _trimmed_display_name(cls, value: str) -> str:
        """Reject blank display names and store the trimmed form."""
        trimmed = value.strip()
        if not trimmed:
            msg = "display_name must not be blank"
            raise ValueError(msg)
        return trimmed

    @field_validator("input_modalities", "output_modalities")
    @classmethod
    def _valid_modalities(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        """Reject modalities outside the schema's vocabulary."""
        return _validated_modalities(value)


class DeploymentAdd(DeploymentCreate):
    """Add one deployment (including a local variant) to an existing model."""

    model_config = ConfigDict(extra="forbid")

    org_id: str | None = None


class WaterfallPut(BaseModel):
    """Replace a waterfall chain with an ordered deployment id list.

    An empty list clears the org's override (falling back to the default
    chain); for a platform admin acting with ``org_id: null`` it empties the
    default chain itself.
    """

    model_config = ConfigDict(extra="forbid")

    org_id: str | None = None
    model_provider_ids: tuple[str, ...]


# ---------------------------------------------------------------------------
# Views (explicit projections; never serialize rows wholesale)


class ModelView(BaseModel):
    """Customer-safe projection of one ``models`` row."""

    model_config = ConfigDict(frozen=True)

    id: str
    slug: str
    display_name: str
    description: str | None
    release_date: str | None
    context_window: int | None
    max_output_tokens: int | None
    input_modalities: tuple[str, ...]
    output_modalities: tuple[str, ...]
    supported_params: JsonObject
    category: str | None
    tags: tuple[str, ...]
    owning_org_id: str | None
    preferred_rank: int | None
    status: str
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> ModelView:
        """Project the catalog fields explicitly."""
        owning = row.get("owning_org_id")
        release_date = row.get("release_date")
        return cls(
            id=str(row["id"]),
            slug=str(row["slug"]),
            display_name=str(row["display_name"]),
            description=cast("str | None", row.get("description")),
            release_date=None if release_date is None else str(release_date),
            context_window=cast("int | None", row.get("context_window")),
            max_output_tokens=cast("int | None", row.get("max_output_tokens")),
            input_modalities=tuple(cast("list[str]", row["input_modalities"])),
            output_modalities=tuple(cast("list[str]", row["output_modalities"])),
            supported_params=cast("JsonObject", row["supported_params"]),
            category=cast("str | None", row.get("category")),
            tags=tuple(cast("list[str]", row.get("tags") or [])),
            owning_org_id=None if owning is None else str(owning),
            preferred_rank=cast("int | None", row.get("preferred_rank")),
            status=str(row["status"]),
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
        )


class DeploymentView(BaseModel):
    """Customer-safe projection of one ``model_providers`` row."""

    model_config = ConfigDict(frozen=True)

    id: str
    model_id: str
    provider: str
    provider_model_id: str
    base_url: str | None
    region: str | None
    api_version: str | None
    owning_org_id: str | None
    provider_connection_id: str | None
    billing_source: str
    input_micro_usd_per_million: int | None
    cached_input_micro_usd_per_million: int | None
    output_micro_usd_per_million: int | None
    reasoning_micro_usd_per_million: int | None
    pricing_source: str | None
    pricing_effective_at: str | None
    capabilities: JsonObject
    uptime_30d: float | None
    throughput_tps: float | None
    latency_p50_ms: float | None
    stats_source: str | None
    status: str
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: JsonObject) -> DeploymentView:
        """Project the deployment fields explicitly."""
        owning = row.get("owning_org_id")
        pin = row.get("provider_connection_id")
        effective_at = row.get("pricing_effective_at")
        return cls(
            id=str(row["id"]),
            model_id=str(row["model_id"]),
            provider=str(row["provider"]),
            provider_model_id=str(row["provider_model_id"]),
            base_url=cast("str | None", row.get("base_url")),
            region=cast("str | None", row.get("region")),
            api_version=cast("str | None", row.get("api_version")),
            owning_org_id=None if owning is None else str(owning),
            provider_connection_id=None if pin is None else str(pin),
            billing_source=str(row["billing_source"]),
            input_micro_usd_per_million=cast("int | None", row.get("input_micro_usd_per_million")),
            cached_input_micro_usd_per_million=cast(
                "int | None", row.get("cached_input_micro_usd_per_million")
            ),
            output_micro_usd_per_million=cast(
                "int | None", row.get("output_micro_usd_per_million")
            ),
            reasoning_micro_usd_per_million=cast(
                "int | None", row.get("reasoning_micro_usd_per_million")
            ),
            pricing_source=cast("str | None", row.get("pricing_source")),
            pricing_effective_at=None if effective_at is None else str(effective_at),
            capabilities=cast("JsonObject", row.get("capabilities") or {}),
            uptime_30d=_optional_float(row.get("uptime_30d")),
            throughput_tps=_optional_float(row.get("throughput_tps")),
            latency_p50_ms=_optional_float(row.get("latency_p50_ms")),
            stats_source=cast("str | None", row.get("stats_source")),
            status=str(row["status"]),
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
        )


def _optional_float(value: object) -> float | None:
    """Coerce PostgREST numerics (float or string) without zero-filling nulls."""
    if value is None:
        return None
    return float(cast("float | str", value))


class CatalogModelView(BaseModel):
    """One catalog listing entry: the model with its visible deployments."""

    model: ModelView
    providers: tuple[DeploymentView, ...]


class PromotionView(BaseModel):
    """One promotion, resolved to the models it covers for this viewer.

    The authoritative promotions + caps live in ``public.model_promotions``
    (owned by the promotional-models workstream); this route consumes them
    read-only and resolves each promotion's scope to concrete visible slugs
    (explicit membership, or — for a membership-less lane-scoped promotion —
    every visible model with a deployment on one of its providers). A promoted
    model appears BOTH in the catalog's Promotional section (ordered by
    ``display_order``) AND under its normal family section — the section is a
    display overlay, not a separate list. ``free`` and ``percent_off`` are the
    display terms (the product owner: FREE badges, "% off" section chips); org spend and
    cap amounts stay server-side.
    """

    model_config = ConfigDict(frozen=True)

    label: str
    slugs: tuple[str, ...]
    display_order: int
    free: bool
    percent_off: float
    providers: tuple[str, ...]
    family_keys: tuple[str, ...]


class ModelListView(BaseModel):
    """Response envelope for the catalog listing."""

    models: tuple[CatalogModelView, ...]
    # Active promotional models, ordered; a subset of ``models`` by slug.
    promotions: tuple[PromotionView, ...]
    total: int
    limit: int
    offset: int


class WaterfallRungView(BaseModel):
    """One ordered rung of a waterfall chain, joined to its deployment."""

    model_config = ConfigDict(frozen=True)

    id: str
    position: int
    model_provider_id: str
    provider: str
    provider_model_id: str
    base_url: str | None
    status: str


class ModelBenchmarkView(BaseModel):
    """One public benchmark score with its provenance and display metadata.

    The score and provenance come from ``public.model_benchmarks``; the
    display fields join in from the code-side benchmark registry. A row whose
    benchmark the registry does not know yet still renders (fallback name =
    its slug) so data never disappears behind a stale registry.
    """

    model_config = ConfigDict(frozen=True)

    benchmark: str
    display_name: str
    unit: str
    higher_is_better: bool
    score: float
    source: str
    source_url: str | None
    retrieved_at: str


# Registry insertion order is the display order; unregistered slugs follow
# alphabetically after every registered one.
_BENCHMARK_ORDER = {slug: index for index, slug in enumerate(KNOWN_BENCHMARKS)}


def _benchmark_views(client: SupabaseClient, model_id: str) -> tuple[ModelBenchmarkView, ...]:
    """A model's benchmark scores, registry order first, then unknown slugs."""
    result = client.table("model_benchmarks").select("*").eq("model_id", model_id).execute()
    views: list[ModelBenchmarkView] = []
    for raw in result.data:
        row = dict(raw)
        benchmark = str(row["benchmark"])
        spec = KNOWN_BENCHMARKS.get(benchmark)
        views.append(
            ModelBenchmarkView(
                benchmark=benchmark,
                display_name=benchmark if spec is None else spec.display_name,
                unit="points" if spec is None else spec.unit,
                higher_is_better=True if spec is None else spec.higher_is_better,
                score=float(cast("float | str", row["score"])),
                source=str(row["source"]),
                source_url=cast("str | None", row.get("source_url")),
                retrieved_at=str(row["retrieved_at"]),
            )
        )
    views.sort(
        key=lambda view: (
            _BENCHMARK_ORDER.get(view.benchmark, len(_BENCHMARK_ORDER)),
            view.benchmark,
        )
    )
    return tuple(views)


class ModelDetailView(BaseModel):
    """Model detail: the row, its deployments, and the default chain.

    ``huggingface_url``/``release_url``/``benchmarks`` ride the DETAIL view
    only — the list view stays lean for the full-catalog read. They default to
    empty so the create endpoints (whose fresh rows carry none) reuse the view
    unchanged.
    """

    model: ModelView
    providers: tuple[DeploymentView, ...]
    default_waterfall: tuple[WaterfallRungView, ...]
    huggingface_url: str | None = None
    release_url: str | None = None
    benchmarks: tuple[ModelBenchmarkView, ...] = ()


class DeploymentListView(BaseModel):
    """Response envelope for a model's deployments."""

    model_id: str
    slug: str
    providers: tuple[DeploymentView, ...]


class WaterfallView(BaseModel):
    """A model's default chain plus one org's override, if any."""

    model_id: str
    slug: str
    org_id: str | None
    default: tuple[WaterfallRungView, ...]
    override: tuple[WaterfallRungView, ...] | None


# ---------------------------------------------------------------------------
# Viewer identity (reads render anonymously; an identified caller also sees
# its orgs' private rows)


def get_optional_actor(
    request: Request,
    actor_id: Annotated[str | None, Header(alias=ACTOR_HEADER)] = None,
) -> RequestActor | None:
    """Resolve the acting identity when one is presented, else None.

    Catalog reads are public: the deployment credential alone (no actor
    header) browses the public catalog, while a customer API key, a
    superadmin key, or a session-asserted actor additionally sees the rows
    its authority grants. The superadmin check matters here: a machine
    operator sends no actor header, and without it the key would browse the
    catalog anonymously instead of with the platform-admin view.
    """
    key_org = getattr(request.state, "api_key_org_id", None)
    superadmin_user = getattr(request.state, "superadmin_user_id", None)
    if key_org is None and superadmin_user is None and (actor_id is None or not actor_id.strip()):
        return None
    return get_request_actor(request, actor_id)


OptionalActor = Annotated[RequestActor | None, Depends(get_optional_actor)]


def _viewer_org_ids(client: SupabaseClient, actor: RequestActor | None) -> set[str] | None:
    """Org ids whose private rows the viewer may see; None means every org.

    Platform admins operate the deployment across tenants, so they see all
    rows (the ``require_org_role`` bypass, applied to reads).
    """
    if actor is None:
        return set()
    if actor.is_platform_admin:
        return None
    return actor_org_ids(client, actor)


def _org_visible(owning_org_id: object, viewer_orgs: set[str] | None) -> bool:
    """Whether a row with this owner is visible to the viewer."""
    if owning_org_id is None or viewer_orgs is None:
        return True
    return str(owning_org_id) in viewer_orgs


def _model_visible(row: JsonObject, viewer_orgs: set[str] | None) -> bool:
    """Model visibility: org scoping plus the hidden-status rule.

    Hidden public rows are operator-only; an org's own hidden rows stay
    visible to that org (it hid them and still manages them).
    """
    if not _org_visible(row.get("owning_org_id"), viewer_orgs):
        return False
    if str(row["status"]) == "hidden" and row.get("owning_org_id") is None:
        return viewer_orgs is None
    return True


# ---------------------------------------------------------------------------
# Shared fetch and resolution helpers


def _all_rows(client: SupabaseClient, table: str) -> list[JsonObject]:
    """Fetch a whole table past the PostgREST row cap, stably ordered."""
    rows: list[JsonObject] = []
    offset = 0
    while True:
        result = (
            client.table(table)
            .select("*")
            .order("created_at")
            .order("id")
            .range(offset, offset + _POSTGREST_PAGE_SIZE - 1)
            .execute()
        )
        page = list(result.data)
        rows.extend(page)
        if len(page) < _POSTGREST_PAGE_SIZE:
            return rows
        offset += _POSTGREST_PAGE_SIZE


def _string_tuple(value: object) -> tuple[str, ...]:
    """Validate a raw text[] column into a string tuple (absent -> empty)."""
    if not isinstance(value, list):
        return ()
    return tuple(str(item) for item in cast("list[object]", value))


def _paged(build: Callable[[int], SupabaseQueryBuilder]) -> list[JsonObject]:
    """Walk one stably-ordered query past the PostgREST row cap."""
    rows: list[JsonObject] = []
    offset = 0
    while True:
        page = list(result_rows(build(offset).execute()))
        rows.extend(page)
        if len(page) < _POSTGREST_PAGE_SIZE:
            return rows
        offset += _POSTGREST_PAGE_SIZE


def _promotion_covered_slugs(
    row: JsonObject,
    member_slugs: list[str] | None,
    providers: tuple[str, ...],
    visible_slugs: set[str],
    providers_by_slug: dict[str, set[str]],
) -> set[str]:
    """Resolve one promotion's scope to visible slugs (enforcement's mirror).

    Explicit membership wins; the deliberate covers_all_models flag expands to
    every visible model, narrowed to the promotion's lanes when it has any;
    empty membership WITHOUT the flag (a cascade-emptied scope) resolves to
    nothing, exactly like gateway_promo_state.
    """
    if member_slugs is not None:
        return {slug for slug in member_slugs if slug in visible_slugs}
    if row.get("covers_all_models") is not True:
        return set()
    if not providers:
        return set(visible_slugs)
    provider_set = set(providers)
    return {slug for slug in visible_slugs if providers_by_slug.get(slug, set()) & provider_set}


def _viewer_satisfies_audience(
    client: SupabaseClient,
    viewer_orgs: set[str] | None,
    required_labels: tuple[str, ...],
    label_cache: dict[str, set[str]],
) -> bool:
    """Whether the viewer may SEE an audience-scoped promotion.

    Mirrors gateway_promo_state's audience predicate at display time: the org
    must carry EVERY required org_label. A viewer spanning several orgs sees
    the promotion when any one of them qualifies (that org's traffic would be
    discounted). Platform admins (viewer_orgs is None) see every promotion —
    they operate the deployment. Anonymous viewers and unlabeled orgs do not:
    advertising a discount the money path will refuse is a mis-stated price.
    """
    if not required_labels:
        return True
    if viewer_orgs is None:
        return True
    if not viewer_orgs:
        return False
    if not label_cache:
        for row in _paged(
            lambda offset: (
                client.table("org_labels")
                .select("org_id, key")
                .in_("org_id", sorted(viewer_orgs))
                .order("org_id")
                .range(offset, offset + _POSTGREST_PAGE_SIZE - 1)
            )
        ):
            label_cache.setdefault(str(row["org_id"]), set()).add(str(row["key"]))
        # A sentinel entry marks the cache as loaded even when the viewer's
        # orgs carry no labels at all, so we never refetch per promotion.
        label_cache.setdefault("", set())
    required = set(required_labels)
    return any(required <= label_cache.get(org, set()) for org in viewer_orgs)


def _fetch_promotions(
    client: SupabaseClient,
    visible_slugs: set[str],
    providers_by_slug: dict[str, set[str]],
    viewer_orgs: set[str] | None,
) -> tuple[PromotionView, ...]:
    """Load active promotions, each resolved to the viewer's visible slugs.

    Reads ``public.model_promotions`` + ``model_promotion_models`` (the
    promotional-models workstream owns both; the catalog reads the display
    projection). Scope resolution mirrors the gateway's reserve-time match:
    explicit membership, or — for a promotion whose covers_all_models flag an
    admin deliberately set — every visible model, narrowed to the promotion's
    lanes when it has any. Empty membership WITHOUT the flag (a
    cascade-emptied scope) resolves to nothing, exactly like enforcement. An
    audience-scoped promotion (``audience_labels``) is shown only to viewers
    whose org carries every required label — the same predicate the money
    path applies — so no viewer is shown a discount they cannot receive. A
    promotion that resolves to no visible model is dropped so the section
    never dangles on hidden rows. Active-only server-side; both reads page
    past the PostgREST row cap.
    """
    promo_rows = _paged(
        lambda offset: (
            client.table("model_promotions")
            .select("*")
            .eq("active", value=True)
            .order("display_order")
            .order("label")
            .range(offset, offset + _POSTGREST_PAGE_SIZE - 1)
        )
    )
    members: dict[str, list[str]] = {}
    for row in _paged(
        lambda offset: (
            client.table("model_promotion_models")
            .select("promotion_id, model_id, slug")
            .order("promotion_id")
            .order("model_id")
            .range(offset, offset + _POSTGREST_PAGE_SIZE - 1)
        )
    ):
        members.setdefault(str(row["promotion_id"]), []).append(str(row["slug"]))

    promotions: list[PromotionView] = []
    org_label_cache: dict[str, set[str]] = {}
    for row in promo_rows:
        if row.get("display_order") is None:
            continue
        if not _viewer_satisfies_audience(
            client, viewer_orgs, _string_tuple(row.get("audience_labels")), org_label_cache
        ):
            continue
        promotion_id = str(row["id"])
        providers = _string_tuple(row.get("providers"))
        provider_set = set(providers)
        member_slugs = members.get(promotion_id)
        if member_slugs is not None:
            covered = {slug for slug in member_slugs if slug in visible_slugs}
        elif row.get("covers_all_models") is True:
            covered = (
                {
                    slug
                    for slug in visible_slugs
                    if providers_by_slug.get(slug, set()) & provider_set
                }
                if providers
                else set(visible_slugs)
            )
        else:
            # Cascade-emptied scope: enforcement matches nothing, so neither
            # does the display.
            covered = set()
        if not covered:
            continue
        promotions.append(
            PromotionView(
                label=str(row.get("label") or ""),
                slugs=tuple(sorted(covered)),
                display_order=int(cast("int", row["display_order"])),
                free=int(cast("int", row.get("per_org_cap_micro_usd") or 0)) > 0,
                percent_off=float(cast("float", row.get("percent_off") or 0)),
                providers=providers,
                family_keys=_string_tuple(row.get("family_keys")),
            )
        )
    return tuple(promotions)


def _model_not_found(slug: str) -> ApiError:
    """The catalog's self-correcting 404 for an unresolvable slug."""
    msg = (
        f"model '{slug}' not found in the public catalog or your organizations; "
        f"GET /api/models lists available models and POST /api/models creates a custom one"
    )
    return ApiError(msg, status_code=404)


def _resolve_model(
    client: SupabaseClient,
    slug: str,
    *,
    viewer_orgs: set[str] | None,
    org_id: str | None = None,
) -> JsonObject:
    """Resolve a slug to one visible model row.

    The public catalog and each org are separate slug namespaces; an org's
    custom model shadows a public row of the same slug. ``org_id`` pins the
    namespace explicitly; without it a unique org match wins, then the public
    row, and an ambiguous multi-org match asks the caller to disambiguate.

    Raises:
        ApiError: 404 when no visible row matches, 409 on ambiguity.
    """
    result = client.table("models").select("*").eq("slug", slug).execute()
    rows = [row for row in result.data if _model_visible(dict(row), viewer_orgs)]
    if org_id is not None:
        for row in rows:
            if row.get("owning_org_id") is not None and str(row["owning_org_id"]) == org_id:
                return dict(row)
        for row in rows:
            if row.get("owning_org_id") is None:
                return dict(row)
        raise _model_not_found(slug)
    org_rows = [row for row in rows if row.get("owning_org_id") is not None]
    if len(org_rows) == 1:
        return dict(org_rows[0])
    if len(org_rows) > 1:
        owners = sorted(str(row["owning_org_id"]) for row in org_rows)
        msg = (
            f"model '{slug}' exists in {len(org_rows)} organizations you can see "
            f"({', '.join(owners)}); pass org_id to pick one"
        )
        raise ApiError(msg, status_code=409)
    for row in rows:
        if row.get("owning_org_id") is None:
            return dict(row)
    raise _model_not_found(slug)


def _ordered_deployments(rows: list[JsonObject]) -> list[JsonObject]:
    """Pin experiential_cloud first; keep the incoming order for all others.

    Display and catalog-list order only. Does not add a route or rewrite a
    tenant-authored waterfall.
    """
    leading = [row for row in rows if row.get("provider") == EXPERIENTIAL_CLOUD_PROVIDER]
    if not leading:
        return rows
    trailing = [row for row in rows if row.get("provider") != EXPERIENTIAL_CLOUD_PROVIDER]
    return leading + trailing


def _model_deployments(
    client: SupabaseClient,
    model_id: str,
    *,
    viewer_orgs: set[str] | None,
) -> list[JsonObject]:
    """A model's deployments visible to the viewer, Experiential Cloud first."""
    result = (
        client.table("model_providers")
        .select("*")
        .eq("model_id", model_id)
        .order("created_at")
        .order("id")
        .execute()
    )
    visible = [
        dict(row) for row in result.data if _org_visible(row.get("owning_org_id"), viewer_orgs)
    ]
    return _ordered_deployments(visible)


def _with_observed_stats(
    client: SupabaseClient,
    slug: str,
    providers: list[JsonObject],
) -> list[JsonObject]:
    """Overlay observed catalog stats onto one model's deployment rows."""
    observed = fetch_observed_stats(client)
    return [overlay_deployment_row(row, slug, observed) for row in providers]


def _chain_rows(
    client: SupabaseClient,
    model_id: str,
    org_id: str | None,
) -> list[JsonObject]:
    """One chain's rungs (default when org_id is None), in position order."""
    query = client.table("model_waterfalls").select("*").eq("model_id", model_id)
    query = query.is_("org_id", "null") if org_id is None else query.eq("org_id", org_id)
    result = query.order("position").execute()
    return [dict(row) for row in result.data]


def _rung_views(
    client: SupabaseClient,
    model_id: str,
    rungs: list[JsonObject],
) -> tuple[WaterfallRungView, ...]:
    """Join chain rungs to their deployments for a readable chain view."""
    deployments = {
        str(row["id"]): row for row in _model_deployments(client, model_id, viewer_orgs=None)
    }
    views: list[WaterfallRungView] = []
    for rung in rungs:
        deployment = deployments.get(str(rung["model_provider_id"]))
        if deployment is None:
            # The composite FK cascades rung deletion with its deployment, so
            # a dangling rung can only be a read racing a delete; skip it.
            continue
        views.append(
            WaterfallRungView(
                id=str(rung["id"]),
                position=int(cast("int", rung["position"])),
                model_provider_id=str(rung["model_provider_id"]),
                provider=str(deployment["provider"]),
                provider_model_id=str(deployment["provider_model_id"]),
                base_url=cast("str | None", deployment.get("base_url")),
                status=str(deployment["status"]),
            )
        )
    return tuple(views)


def _resolve_write_org(
    client: SupabaseClient,
    actor: RequestActor,
    org_id: str | None,
) -> str | None:
    """Resolve which organization a write belongs to.

    A customer API key acts for exactly its org; a session actor must name
    one it belongs to; a platform admin may pass None to operate on the
    public catalog.

    Raises:
        ApiError: 404 for orgs the actor cannot act in, 422 when a session
            actor omits org_id.
    """
    if actor.api_key_org_id is not None:
        if org_id is not None and org_id != actor.api_key_org_id:
            msg = f"Organization not found: {org_id}"
            raise ApiError(msg, status_code=404)
        return actor.api_key_org_id
    if actor.is_platform_admin:
        if org_id is None:
            return None
        load_org_row(client, org_id)
        return org_id
    if org_id is None:
        msg = (
            "org_id is required: name the organization this write belongs to "
            "(GET /api/orgs lists your organizations)"
        )
        raise ApiError(msg, status_code=422)
    load_org_row(client, org_id)
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.USER,
        not_found=f"Organization not found: {org_id}",
    )
    return org_id


def _translated_write_error(error: PostgrestAPIError, *, action: str) -> ApiError:
    """Map a database rejection to a self-correcting client error.

    The schema's tenancy guards raise 23514 with messages written to be shown
    verbatim; unique and FK violations get the same treatment. Anything else
    is a real server fault and re-raises.
    """
    detail = error.message or "database rejected the write"
    if error.code == _UNIQUE_VIOLATION:
        msg = f"{action} conflicts with an existing row: {detail}"
        return ApiError(msg, status_code=409)
    if error.code == _CHECK_VIOLATION:
        msg = f"{action} rejected: {detail}"
        return ApiError(msg, status_code=422)
    if error.code == _FK_VIOLATION:
        msg = f"{action} references a row that does not exist: {detail}"
        return ApiError(msg, status_code=422)
    raise error


def _matches_payload(row: JsonObject, payload: JsonObject) -> bool:
    """Whether an existing row already carries exactly this write's values."""
    for column, value in payload.items():
        if column in _VOLATILE_COLUMNS:
            continue
        current = row.get(column)
        if column == "release_date" and current is not None:
            current = str(current)[:10]
        if current != value:
            return False
    return True


# ---------------------------------------------------------------------------
# Reads


def _sort_value(
    sort: ModelSort,
    model: JsonObject,
    providers: list[JsonObject],
) -> float | None:
    """The comparable the caller sorted by, as a number; None when unknown."""
    match sort:
        case "preferred":
            rank = cast("int | None", model.get("preferred_rank"))
            return None if rank is None else float(rank)
        case "price":
            prices = [
                float(cast("int", row["input_micro_usd_per_million"]))
                for row in providers
                if row.get("input_micro_usd_per_million") is not None
            ]
            return min(prices) if prices else None
        case "age":
            release_date = model.get("release_date")
            if release_date is None:
                return None
            return float(datetime.date.fromisoformat(str(release_date)[:10]).toordinal())
        case "context":
            window = cast("int | None", model.get("context_window"))
            return None if window is None else float(window)
        case "throughput":
            values = [
                float(cast("float | str", row["throughput_tps"]))
                for row in providers
                if row.get("throughput_tps") is not None
            ]
            return max(values) if values else None


# Each sort's natural direction when the caller does not pass one: prices
# ascend, everything else shows the biggest/newest/pinned-first.
_DEFAULT_ORDER: dict[str, SortOrder] = {
    "preferred": "asc",
    "price": "asc",
    "age": "desc",
    "context": "desc",
    "throughput": "desc",
}


def _sorted_entries(
    entries: list[tuple[JsonObject, list[JsonObject]]],
    sort: ModelSort,
    order: SortOrder | None,
) -> list[tuple[JsonObject, list[JsonObject]]]:
    """Sort catalog entries with unknown values last regardless of direction."""
    direction = order or _DEFAULT_ORDER[sort]
    keyed = [
        (_sort_value(sort, model, providers), (model, providers)) for model, providers in entries
    ]
    known = [(value, entry) for value, entry in keyed if value is not None]
    unknown = [entry for value, entry in keyed if value is None]
    # The slug tiebreaker keeps pagination stable; unknowns sort last in both
    # directions rather than pretending an unknown price/date is extreme.
    known.sort(key=lambda item: (item[0], str(item[1][0]["slug"])))
    if direction == "desc":
        known.sort(key=lambda item: item[0], reverse=True)
    unknown.sort(key=lambda entry: str(entry[0]["slug"]))
    return [entry for _, entry in known] + unknown


@dataclass(frozen=True)
class _CatalogFilters:
    """The catalog listing's filter set, validated against the vocabularies."""

    modality: str | None
    category: str | None
    provider: str | None
    min_context: int | None
    max_input_micro_usd_per_million: int | None
    supports: str | None

    def __post_init__(self) -> None:
        """Reject values outside the schema's vocabularies with a 422."""
        if self.modality is not None and self.modality not in _MODALITIES:
            msg = f"unknown modality '{self.modality}'; allowed values: {', '.join(_MODALITIES)}"
            raise ApiError(msg, status_code=422)
        if self.provider is not None and self.provider not in _PROVIDERS:
            msg = f"unknown provider '{self.provider}'; allowed values: {', '.join(_PROVIDERS)}"
            raise ApiError(msg, status_code=422)

    def admits(self, model: JsonObject, providers: list[JsonObject]) -> bool:
        """Whether one catalog entry passes every requested filter."""
        if self.modality is not None and self.modality not in cast(
            "list[str]", model["input_modalities"]
        ):
            return False
        if self.category is not None and model.get("category") != self.category:
            return False
        if self.provider is not None and all(row["provider"] != self.provider for row in providers):
            return False
        if self.min_context is not None and (
            model.get("context_window") is None
            or int(cast("int", model["context_window"])) < self.min_context
        ):
            return False
        if self.max_input_micro_usd_per_million is not None:
            cheapest = _sort_value("price", model, providers)
            if cheapest is None or cheapest > self.max_input_micro_usd_per_million:
                return False
        return not (
            self.supports is not None
            and cast("JsonObject", model["supported_params"]).get(self.supports) is not True
        )


@router.get("/models", response_model=ModelListView)
def list_models(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: OptionalActor,
    *,
    modality: Annotated[str | None, Query()] = None,
    category: Annotated[str | None, Query()] = None,
    provider: Annotated[str | None, Query()] = None,
    min_context: Annotated[int | None, Query(ge=1)] = None,
    max_input_micro_usd_per_million: Annotated[int | None, Query(ge=0)] = None,
    supports: Annotated[str | None, Query(min_length=1)] = None,
    owner: Annotated[Literal["org"] | None, Query()] = None,
    audience_org: Annotated[str | None, Query(min_length=1)] = None,
    sort: Annotated[ModelSort, Query()] = "preferred",
    order: Annotated[SortOrder | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 500,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ModelListView:
    """List the catalog: public rows plus the viewer's orgs' own models.

    ``owner=org`` narrows the result to only the viewer's organizations' own
    rows, dropping the public catalog. The public storefront caches its shared,
    org-agnostic base once for every visitor and overlays each signed-in
    viewer's own models with this thin, per-user read, so org-scoped rows never
    enter the shared cache. Anonymous callers own no rows, so the overlay is
    empty.
    """
    filters = _CatalogFilters(
        modality=modality,
        category=category,
        provider=provider,
        min_context=min_context,
        max_input_micro_usd_per_million=max_input_micro_usd_per_million,
        supports=supports,
    )
    viewer_orgs = _viewer_org_ids(client, actor)
    # Promotions are audience-checked per ORGANIZATION, and a workspace acts as
    # exactly one org at a time. When the caller names its acting org, the
    # audience predicate narrows to that org alone (a user whose OTHER org
    # qualifies must not be shown a discount this org's traffic will not get).
    # The org must be one the viewer may act for; platform admins may name any.
    audience_orgs = viewer_orgs
    if audience_org is not None:
        if viewer_orgs is not None and audience_org not in viewer_orgs:
            msg = "audience_org is not one of your organizations"
            raise ApiError(msg, status_code=403)
        audience_orgs = {audience_org}
    visible_models = [
        row for row in _all_rows(client, "models") if _model_visible(row, viewer_orgs)
    ]
    # The owner filter narrows the RETURNED rows only. Promotions (and the
    # deployment alias overlay) resolve against everything the viewer can see:
    # an owner=org overlay read still reports the viewer's full promotion set,
    # which the storefront swaps in for its cached anonymous one.
    models = (
        [row for row in visible_models if row.get("owning_org_id") is not None]
        if owner == "org"
        else visible_models
    )
    slug_by_model_id = {str(model["id"]): str(model["slug"]) for model in visible_models}
    observed = fetch_observed_stats(client)
    deployments_by_model: dict[str, list[JsonObject]] = {}
    for row in _all_rows(client, "model_providers"):
        if _org_visible(row.get("owning_org_id"), viewer_orgs):
            model_id = str(row["model_id"])
            alias = slug_by_model_id.get(model_id)
            overlaid = row if alias is None else overlay_deployment_row(row, alias, observed)
            deployments_by_model.setdefault(model_id, []).append(overlaid)

    entries = [
        (model, deployments_by_model.get(str(model["id"]), []))
        for model in models
        if filters.admits(model, deployments_by_model.get(str(model["id"]), []))
    ]
    ordered = _sorted_entries(entries, sort, order)
    page = ordered[offset : offset + limit]
    # Promotions are audience-resolved for this viewer; surface those whose
    # models are visible to this viewer so the promo section never dangles on a
    # hidden row. The per-slug provider sets resolve lane-scoped promotions to
    # the models those lanes actually serve.
    providers_by_slug = {
        slug_by_model_id[model_id]: {
            str(deployment.get("provider"))
            for deployment in deployments
            if deployment.get("provider") is not None
        }
        for model_id, deployments in deployments_by_model.items()
        if model_id in slug_by_model_id
    }
    promotions = _fetch_promotions(
        client, set(slug_by_model_id.values()), providers_by_slug, audience_orgs
    )
    return ModelListView(
        models=tuple(
            CatalogModelView(
                model=ModelView.from_row(model),
                providers=tuple(
                    DeploymentView.from_row(row) for row in _ordered_deployments(list(providers))
                ),
            )
            for model, providers in page
        ),
        promotions=promotions,
        total=len(ordered),
        limit=limit,
        offset=offset,
    )


@router.get("/models/{slug}", response_model=ModelDetailView)
def get_model(
    slug: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: OptionalActor,
    *,
    org_id: Annotated[str | None, Query()] = None,
) -> ModelDetailView:
    """One model's detail: row, visible deployments, and the default chain."""
    viewer_orgs = _viewer_org_ids(client, actor)
    if org_id is not None and viewer_orgs is not None and org_id not in viewer_orgs:
        raise _model_not_found(slug)
    model = _resolve_model(client, slug, viewer_orgs=viewer_orgs, org_id=org_id)
    model_id = str(model["id"])
    providers = _with_observed_stats(
        client, str(model["slug"]), _model_deployments(client, model_id, viewer_orgs=viewer_orgs)
    )
    default_chain = _rung_views(client, model_id, _chain_rows(client, model_id, None))
    huggingface_url = model.get("huggingface_url")
    release_url = model.get("release_url")
    return ModelDetailView(
        model=ModelView.from_row(model),
        providers=tuple(DeploymentView.from_row(row) for row in providers),
        default_waterfall=default_chain,
        huggingface_url=None if huggingface_url is None else str(huggingface_url),
        release_url=None if release_url is None else str(release_url),
        benchmarks=_benchmark_views(client, model_id),
    )


@router.get("/models/{slug}/providers", response_model=DeploymentListView)
def list_model_providers(
    slug: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: OptionalActor,
    *,
    org_id: Annotated[str | None, Query()] = None,
) -> DeploymentListView:
    """A model's deployments visible to the viewer."""
    viewer_orgs = _viewer_org_ids(client, actor)
    if org_id is not None and viewer_orgs is not None and org_id not in viewer_orgs:
        raise _model_not_found(slug)
    model = _resolve_model(client, slug, viewer_orgs=viewer_orgs, org_id=org_id)
    model_id = str(model["id"])
    providers = _with_observed_stats(
        client, str(model["slug"]), _model_deployments(client, model_id, viewer_orgs=viewer_orgs)
    )
    return DeploymentListView(
        model_id=model_id,
        slug=str(model["slug"]),
        providers=tuple(DeploymentView.from_row(row) for row in providers),
    )


# ---------------------------------------------------------------------------
# Writes


def _validate_deployment_payload(
    client: SupabaseClient,
    owning_org_id: str | None,
    dep: DeploymentCreate,
) -> None:
    """Pre-flight the schema's deployment rules for self-correcting 4xxs.

    The database constraints and tenancy triggers stay the backstop; these
    checks exist so an agent reads what to change instead of a raw 23514.
    """
    if dep.provider in _BASE_URL_PROVIDERS:
        if dep.base_url is None:
            msg = (
                f"provider '{dep.provider}' requires base_url: the deployment's "
                f"OpenAI-compatible endpoint, e.g. https://your-host:8000/v1"
            )
            raise ApiError(msg, status_code=422)
    elif dep.provider in _OPTIONAL_BASE_URL_PROVIDERS:
        if owning_org_id is not None:
            msg = f"{PROVIDER_DESCRIPTION} An organization cannot attach it as a private variant."
            raise ApiError(msg, status_code=422)
    elif dep.base_url is not None:
        allowed = sorted(_BASE_URL_PROVIDERS | _OPTIONAL_BASE_URL_PROVIDERS)
        msg = (
            f"base_url is only valid for providers {allowed}; provider "
            f"'{dep.provider}' addresses a fixed origin, so drop base_url"
        )
        raise ApiError(msg, status_code=422)
    if dep.provider_connection_id is None:
        return
    if owning_org_id is None:
        msg = (
            "provider_connection_id pins an organization credential; a public "
            "deployment cannot carry one, so drop it or pass org_id"
        )
        raise ApiError(msg, status_code=422)
    connection = find_one_by_columns(
        client,
        "provider_connections",
        {"id": dep.provider_connection_id},
    )
    if connection is None or str(connection["org_id"]) != owning_org_id:
        msg = f"provider connection not found: {dep.provider_connection_id}"
        raise ApiError(msg, status_code=404)
    if str(connection["provider"]) != dep.provider:
        msg = (
            f"provider connection {dep.provider_connection_id} holds a "
            f"'{connection['provider']}' credential and cannot pin a "
            f"'{dep.provider}' deployment; pick a matching connection"
        )
        raise ApiError(msg, status_code=422)


def _carries_pricing(dep: DeploymentCreate) -> bool:
    """Whether the request asserts any price, stamping its effective time."""
    return any(
        value is not None
        for value in (
            dep.input_micro_usd_per_million,
            dep.cached_input_micro_usd_per_million,
            dep.output_micro_usd_per_million,
            dep.reasoning_micro_usd_per_million,
            dep.pricing_source,
        )
    )


def _deployment_insert_payload(
    model_id: str,
    owning_org_id: str | None,
    dep: DeploymentCreate,
    *,
    billing_source: str = "customer_managed",
    status: str = "active",
) -> JsonObject:
    """Build the full ``model_providers`` insert row.

    Defaults are written explicitly so the row is complete wherever the
    client-side defaults and the schema's agree. ``billing_source`` and
    ``status`` default to the self-serve provider-create contract
    (customer-funded, immediately active); the platform-admin Experiential
    Cloud path overrides them (``host_managed`` and a staged ``disabled``) so
    it shares this one insert path rather than forking a parallel writer.
    """
    now = _utc_now_iso()
    return {
        "model_id": model_id,
        "provider": dep.provider,
        "provider_model_id": dep.provider_model_id,
        "base_url": dep.base_url,
        "region": dep.region,
        "api_version": dep.api_version,
        "owning_org_id": owning_org_id,
        "provider_connection_id": dep.provider_connection_id,
        "billing_source": billing_source,
        "input_micro_usd_per_million": dep.input_micro_usd_per_million,
        "cached_input_micro_usd_per_million": dep.cached_input_micro_usd_per_million,
        "output_micro_usd_per_million": dep.output_micro_usd_per_million,
        "reasoning_micro_usd_per_million": dep.reasoning_micro_usd_per_million,
        "pricing_source": dep.pricing_source,
        "pricing_effective_at": now if _carries_pricing(dep) else None,
        "capabilities": dict(dep.capabilities),
        "uptime_30d": dep.uptime_30d,
        "throughput_tps": dep.throughput_tps,
        "latency_p50_ms": dep.latency_p50_ms,
        "stats_source": dep.stats_source,
        "status": status,
        "created_at": now,
        "updated_at": now,
    }


def _find_deployment_by_identity(
    client: SupabaseClient,
    model_id: str,
    owning_org_id: str | None,
    dep: DeploymentCreate,
) -> JsonObject | None:
    """Find the row the identity key (nulls-not-distinct) would collide with."""
    query = (
        client.table("model_providers")
        .select("*")
        .eq("model_id", model_id)
        .eq("provider", dep.provider)
        .eq("provider_model_id", dep.provider_model_id)
    )
    query = (
        query.is_("owning_org_id", "null")
        if owning_org_id is None
        else query.eq("owning_org_id", owning_org_id)
    )
    query = (
        query.is_("base_url", "null")
        if dep.base_url is None
        else query.eq("base_url", dep.base_url)
    )
    result = query.limit(1).execute()
    if not result.data:
        return None
    return dict(result.data[0])


def _create_or_replay_deployment(
    client: SupabaseClient,
    model_id: str,
    slug: str,
    owning_org_id: str | None,
    dep: DeploymentCreate,
    *,
    billing_source: str = "customer_managed",
    status: str = "active",
) -> tuple[JsonObject, bool]:
    """Insert one deployment, or return the identical existing row on replay.

    ``billing_source`` and ``status`` default to the self-serve provider-create
    contract; the platform-admin Experiential Cloud path passes ``host_managed``
    and a staged ``disabled`` so it shares this idempotent writer instead of
    forking a parallel one.

    Returns:
        The row and whether it was created by this call.

    Raises:
        ApiError: 409 when the identity exists with different attributes,
            translated database rejections otherwise.
    """
    payload = _deployment_insert_payload(
        model_id, owning_org_id, dep, billing_source=billing_source, status=status
    )

    def replay_or_conflict(existing: JsonObject) -> JsonObject:
        if _matches_payload(existing, payload):
            return existing
        msg = (
            f"deployment ({dep.provider}, {dep.provider_model_id}) already exists "
            f"on model '{slug}' with different attributes; "
            f"GET /api/models/{slug}/providers to inspect it"
        )
        raise ApiError(msg, status_code=409)

    existing = _find_deployment_by_identity(client, model_id, owning_org_id, dep)
    if existing is not None:
        return replay_or_conflict(existing), False
    try:
        result = client.table("model_providers").insert(payload).execute()
    except PostgrestAPIError as error:
        if error.code == _UNIQUE_VIOLATION:
            # Lost a race with an identical retry; converge on its row.
            raced = _find_deployment_by_identity(client, model_id, owning_org_id, dep)
            if raced is not None:
                return replay_or_conflict(raced), False
        raise _translated_write_error(
            error, action=f"adding a deployment to model '{slug}'"
        ) from error
    return dict(result.data[0]), True


def _ensure_default_chain(
    client: SupabaseClient,
    model_id: str,
    deployment_ids: list[str],
) -> None:
    """Create the model's default chain when none exists yet.

    Create-if-missing mirrors the seed convention: once chain edits happened
    through this API, a replayed create must not rewrite them.
    """
    if _chain_rows(client, model_id, None):
        return
    now = _utc_now_iso()
    rungs: list[JsonObject] = [
        {
            "model_id": model_id,
            "org_id": None,
            "position": position,
            "model_provider_id": deployment_id,
            "created_at": now,
            "updated_at": now,
        }
        for position, deployment_id in enumerate(deployment_ids)
    ]
    try:
        client.table("model_waterfalls").insert(rungs).execute()
    except PostgrestAPIError as error:
        if error.code == _UNIQUE_VIOLATION:
            # A concurrent replay already wrote the chain; it is identical.
            return
        raise _translated_write_error(error, action="creating the default waterfall") from error


def _model_insert_payload(owning_org_id: str | None, body: ModelCreate) -> JsonObject:
    """Build the full ``models`` insert row with explicit defaults."""
    now = _utc_now_iso()
    return {
        "slug": body.slug,
        "display_name": body.display_name,
        "description": body.description,
        "release_date": None if body.release_date is None else body.release_date.isoformat(),
        "context_window": body.context_window,
        "max_output_tokens": body.max_output_tokens,
        "input_modalities": list(body.input_modalities),
        "output_modalities": list(body.output_modalities),
        "supported_params": dict(body.supported_params),
        "category": body.category,
        "tags": list(body.tags),
        "owning_org_id": owning_org_id,
        # preferred_rank is deliberately ABSENT (defaults to null): the
        # recommended band belongs to recommended_models_apply, and leaving it
        # out of the payload keeps idempotent replays from 409ing against a
        # row an admin starred after creation.
        "status": "active",
        "created_at": now,
        "updated_at": now,
    }


def _find_model_by_namespace(
    client: SupabaseClient,
    slug: str,
    owning_org_id: str | None,
) -> JsonObject | None:
    """Find the row the namespace slug key would collide with."""
    query = client.table("models").select("*").eq("slug", slug)
    query = (
        query.is_("owning_org_id", "null")
        if owning_org_id is None
        else query.eq("owning_org_id", owning_org_id)
    )
    result = query.limit(1).execute()
    if not result.data:
        return None
    return dict(result.data[0])


def _create_or_replay_model_row(
    client: SupabaseClient,
    body: ModelCreate,
    owning_org_id: str | None,
) -> tuple[JsonObject, bool]:
    """Insert the ``models`` row, or converge on an identical existing one.

    Returns:
        The row and whether it was created by this call.

    Raises:
        ApiError: 409 when the slug exists in the namespace with different
            attributes, translated database rejections otherwise.
    """
    payload = _model_insert_payload(owning_org_id, body)
    action = f"creating model '{body.slug}'"
    existing = _find_model_by_namespace(client, body.slug, owning_org_id)
    if existing is None:
        try:
            result = client.table("models").insert(payload).execute()
        except PostgrestAPIError as error:
            if error.code == _UNIQUE_VIOLATION:
                # Lost a race with an identical retry; converge on its row.
                existing = _find_model_by_namespace(client, body.slug, owning_org_id)
            if existing is None:
                raise _translated_write_error(error, action=action) from error
        else:
            return dict(result.data[0]), True
    if _matches_payload(existing, payload):
        return existing, False
    namespace = "the public catalog" if owning_org_id is None else "your organization"
    msg = (
        f"model '{body.slug}' already exists in {namespace} with different "
        f"attributes; GET /api/models/{body.slug} to inspect it or pick "
        f"another slug"
    )
    raise ApiError(msg, status_code=409)


@router.post("/models", response_model=ModelDetailView, status_code=201)
def create_model(
    body: ModelCreate,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    response: Response,
) -> ModelDetailView:
    """Create a custom model: catalog row, deployments, and default chain.

    Idempotent on retry: an exact replay converges on the existing rows and
    answers 200 instead of 201; the same slug with different attributes
    answers 409.
    """
    owning_org_id = _resolve_write_org(client, actor, body.org_id)
    for dep in body.providers:
        _validate_deployment_payload(client, owning_org_id, dep)

    model, created = _create_or_replay_model_row(client, body, owning_org_id)
    model_id = str(model["id"])
    deployment_ids: list[str] = []
    try:
        for dep in body.providers:
            row, _ = _create_or_replay_deployment(client, model_id, body.slug, owning_org_id, dep)
            deployment_ids.append(str(row["id"]))
    except (ApiError, PostgrestAPIError):
        if created:
            # A custom model must never exist without a deployment; undo the
            # row this call created so the client can retry cleanly (the
            # delete cascades to any deployments already inserted).
            delete_query = cast("DeleteCapableQuery", client.table("models"))
            delete_query.delete().eq("id", model_id).execute()
        raise
    _ensure_default_chain(client, model_id, deployment_ids)

    viewer_orgs = None if owning_org_id is None else {owning_org_id}
    providers = _model_deployments(client, model_id, viewer_orgs=viewer_orgs)
    if not created:
        response.status_code = 200
    return ModelDetailView(
        model=ModelView.from_row(model),
        providers=tuple(DeploymentView.from_row(row) for row in providers),
        default_waterfall=_rung_views(client, model_id, _chain_rows(client, model_id, None)),
    )


@router.post("/models/{slug}/providers", response_model=DeploymentView, status_code=201)
def add_model_provider(
    slug: str,
    body: DeploymentAdd,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    response: Response,
) -> DeploymentView:
    """Add a deployment (including a local variant) to an existing model.

    On a public model the new deployment is the org's private route to it; on
    the org's own model it extends the model itself. Idempotent on retry via
    the deployment identity key.
    """
    owning_org_id = _resolve_write_org(client, actor, body.org_id)
    _validate_deployment_payload(client, owning_org_id, body)
    viewer_orgs = None if owning_org_id is None else {owning_org_id}
    model = _resolve_model(client, slug, viewer_orgs=viewer_orgs, org_id=owning_org_id)
    model_org = model.get("owning_org_id")
    if model_org is not None and owning_org_id is None:
        # Platform admins acting publicly do not attach public deployments to
        # a tenant's private model; the tenancy trigger would reject it too.
        raise _model_not_found(slug)
    row, created = _create_or_replay_deployment(client, str(model["id"]), slug, owning_org_id, body)
    if not created:
        response.status_code = 200
    return DeploymentView.from_row(row)


def _validated_chain_deployments(
    client: SupabaseClient,
    model: JsonObject,
    org_id: str | None,
    deployment_ids: tuple[str, ...],
) -> None:
    """Pre-flight a chain replacement so rejections read as instructions.

    Every id must be a deployment of this model, appear once, and be public
    or owned by the chain's tenant (the schema's guard would raise 23514 for
    the same conditions).
    """
    slug = str(model["slug"])
    duplicates = {
        deployment_id for deployment_id in deployment_ids if deployment_ids.count(deployment_id) > 1
    }
    if duplicates:
        msg = (
            f"model_provider_ids repeats {sorted(duplicates)}; a deployment "
            f"appears at most once per chain, so de-duplicate the list"
        )
        raise ApiError(msg, status_code=422)
    rows = {
        str(row["id"]): row
        for row in _model_deployments(client, str(model["id"]), viewer_orgs=None)
    }
    for deployment_id in deployment_ids:
        row = rows.get(deployment_id)
        # The default chain (org_id None) serves every tenant, so it may only
        # carry public rungs; an org's chain carries public rungs or its own.
        row_org = None if row is None else row.get("owning_org_id")
        chainable = row is not None and (
            row_org is None or (org_id is not None and str(row_org) == org_id)
        )
        if not chainable:
            # Foreign-org deployments answer the same 404 as absent ids, so a
            # chain write cannot be used to probe other tenants' rows.
            msg = (
                f"deployment {deployment_id} not found on model '{slug}'; "
                f"GET /api/models/{slug}/providers lists the ids you can chain"
            )
            raise ApiError(msg, status_code=404)


@router.get("/models/{slug}/waterfall", response_model=WaterfallView)
def get_model_waterfall(
    slug: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    *,
    org_id: Annotated[str | None, Query()] = None,
) -> WaterfallView:
    """Read a model's default chain and the acting org's override."""
    acting_org = _resolve_write_org(client, actor, org_id)
    viewer_orgs = None if acting_org is None else {acting_org}
    model = _resolve_model(client, slug, viewer_orgs=viewer_orgs, org_id=acting_org)
    model_id = str(model["id"])
    default_chain = _rung_views(client, model_id, _chain_rows(client, model_id, None))
    override_rows = [] if acting_org is None else _chain_rows(client, model_id, acting_org)
    return WaterfallView(
        model_id=model_id,
        slug=str(model["slug"]),
        org_id=acting_org,
        default=default_chain,
        override=_rung_views(client, model_id, override_rows) if override_rows else None,
    )


@router.put("/models/{slug}/waterfall", response_model=WaterfallView)
def put_model_waterfall(
    slug: str,
    body: WaterfallPut,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> WaterfallView:
    """Replace the acting org's waterfall override with an ordered chain.

    An empty list clears the override. A platform admin acting with
    ``org_id: null`` replaces the model's default chain instead. Naturally
    idempotent: replaying the same PUT converges on the same rungs.
    """
    acting_org = _resolve_write_org(client, actor, body.org_id)
    viewer_orgs = None if acting_org is None else {acting_org}
    model = _resolve_model(client, slug, viewer_orgs=viewer_orgs, org_id=acting_org)
    model_id = str(model["id"])
    _validated_chain_deployments(client, model, acting_org, body.model_provider_ids)

    delete_query = (
        cast("DeleteCapableQuery", client.table("model_waterfalls"))
        .delete()
        .eq("model_id", model_id)
    )
    delete_query = (
        delete_query.is_("org_id", "null")
        if acting_org is None
        else delete_query.eq("org_id", acting_org)
    )
    delete_query.execute()
    now = _utc_now_iso()
    if body.model_provider_ids:
        rungs: list[JsonObject] = [
            {
                "model_id": model_id,
                "org_id": acting_org,
                "position": position,
                "model_provider_id": deployment_id,
                "created_at": now,
                "updated_at": now,
            }
            for position, deployment_id in enumerate(body.model_provider_ids)
        ]
        try:
            client.table("model_waterfalls").insert(rungs).execute()
        except PostgrestAPIError as error:
            raise _translated_write_error(
                error, action=f"replacing the waterfall of model '{slug}'"
            ) from error
    # A chain replacement that only deletes rungs leaves no fresh row
    # timestamp behind; touch the model so the catalog builder's 15s poll
    # observes the write (set_updated_at overrides the value with now()).
    client.table("models").update({"updated_at": now}).eq("id", model_id).execute()

    default_chain = _rung_views(client, model_id, _chain_rows(client, model_id, None))
    override_rows = [] if acting_org is None else _chain_rows(client, model_id, acting_org)
    return WaterfallView(
        model_id=model_id,
        slug=str(model["slug"]),
        org_id=acting_org,
        default=default_chain,
        override=_rung_views(client, model_id, override_rows) if override_rows else None,
    )
