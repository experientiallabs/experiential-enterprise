# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Gateway control endpoints: usage reads, key limits, workers, catalog.

The control-plane surface other workstreams build on. Usage reads project the
canonical gateway usage tables (``gateway_usage_daily`` for the account
Overview page's per-user rollups, ``gateway_usage_events`` for the paginated
per-request stream); the key-limits pair is the one direct write the control
API owns on gateway state (per-key guardrails carry no gateway invariant);
workers and catalog are pure projections for operators and tenant UIs. All
queries execute inside Postgres through the gateway read RPCs so each response
is one indexed statement; this layer gates tenancy and shapes typed responses.

Money semantics on the read side: ``gateway_usage_events`` splits charged
money (``cost_micro_usd``, platform-funded settlements with zero-completion
insurance applied) from attributed never-charged estimates
(``estimated_cost_micro_usd``, pass-through traffic); the daily rollup's
``spend_micro_usd`` is the single user-facing meter (charged + estimated).
"""

from __future__ import annotations

import base64
import binascii
import enum
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.routes import ApiError, get_supabase
from explabs.api.tenancy import (
    OrgRole,
    RequestActor,
    get_request_actor,
    require_org_role,
    require_platform_admin,
    resolve_acting_org,
)
from explabs.db.repositories import (
    JsonObject,
    SupabaseClient,
    find_one_by_columns,
    result_rows,
)

router = APIRouter(prefix="/api/gateway", tags=["gateway"])

# The identity read lives outside the /api/gateway prefix: agents call it as
# the very first request to learn which org their key acts for.
whoami_router = APIRouter(prefix="/api", tags=["whoami"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]

# The rollup's bucket for usage whose key had no recorded creator; projected
# as a null user in API responses.
_UNATTRIBUTED_USER_ID = "00000000-0000-0000-0000-000000000000"

# A worker that has not heartbeated for this long is presumed gone; the
# heartbeat loop runs every 20s, so this tolerates two missed beats.
_WORKER_STALE_AFTER = timedelta(seconds=60)

# RPC-side caps, mirrored here so the routes can tell a full page (mint a
# next cursor) from a short one (end of the stream).
_EVENTS_LIMIT_CAP = 200
_DAILY_LIMIT_CAP = 2000


class UsageScope(enum.Enum):
    """Whose usage a read returns: the acting user's own, or the org's."""

    SELF = "self"
    ORG = "org"


class UsageGroupBy(enum.Enum):
    """Rollup grouping: time series, top models, or per-member breakdown."""

    DAY = "day"
    # Per-(day, model) cells for the Overview's stacked-by-model hero chart;
    # both the day and alias dimensions are non-null on these rows.
    DAY_MODEL = "day_model"
    MODEL = "model"
    MEMBER = "member"


class DailyUsageRow(BaseModel):
    """One rollup bucket; only the grouped dimension is non-null."""

    day: date | None
    user_id: str | None
    alias: str | None
    requests: int
    input_tokens: int
    output_tokens: int
    spend_micro_usd: int


class DailyUsageResponse(BaseModel):
    """Grouped usage rollup for one organization."""

    org_id: str
    scope: UsageScope
    group_by: UsageGroupBy
    rows: list[DailyUsageRow]


class PlatformUsageGroupBy(enum.Enum):
    """Platform rollup grouping: time series, top models, or per-org breakdown."""

    DAY = "day"
    MODEL = "model"
    ORG = "org"


class PlatformDailyUsageRow(BaseModel):
    """One platform-wide rollup bucket; only the grouped dimension is non-null."""

    day: date | None
    org_id: str | None
    alias: str | None
    requests: int
    input_tokens: int
    output_tokens: int
    spend_micro_usd: int


class PlatformDailyUsageResponse(BaseModel):
    """Grouped usage rollup summed across every organization."""

    group_by: PlatformUsageGroupBy
    rows: list[PlatformDailyUsageRow]


class UsageEventView(BaseModel):
    """One settled request from the canonical usage stream.

    ``cost_micro_usd`` is money actually charged to platform credits;
    ``estimated_cost_micro_usd`` is the attributed never-charged estimate for
    pass-through traffic. They never mix.
    """

    request_id: str
    api_key_id: str | None
    user_id: str | None
    alias: str
    provider: str | None
    lane: Literal["pass_through", "platform_funded"] | None
    input_tokens: int
    output_tokens: int
    cost_micro_usd: int
    estimated_cost_micro_usd: int
    latency_ms: int | None
    status: str
    attempt_count: int
    day: date
    created_at: str


class UsageEventsResponse(BaseModel):
    """One keyset page of usage events, newest first."""

    org_id: str
    events: list[UsageEventView]
    # Opaque; pass back as ``cursor`` to fetch the next page. Null when this
    # page ended the stream.
    next_cursor: str | None


class KeyLimitsView(BaseModel):
    """Effective per-key guardrails (platform-funded lane only).

    ``source`` says whether an explicit ``gateway_key_limits`` row exists or
    the platform defaults apply. Null cap, rpm, or tpm means uncapped.
    """

    api_key_id: str
    daily_spend_cap_micro_usd: int | None
    requests_per_minute: int | None
    tokens_per_minute: int | None
    source: Literal["explicit", "default"]


class KeyLimitsRequest(BaseModel):
    """Body of the key-limits write; omitted or null fields mean uncapped."""

    model_config = ConfigDict(extra="forbid")

    # Upper bounds are sanity rails, far above any real configuration, so a
    # unit mistake (dollars vs micro-USD) fails loudly instead of arming an
    # absurd cap.
    daily_spend_cap_micro_usd: int | None = Field(default=None, ge=0, le=10**15)
    requests_per_minute: int | None = Field(default=None, gt=0, le=100_000)
    tokens_per_minute: int | None = Field(default=None, gt=0, le=10**9)


class WorkerView(BaseModel):
    """One gateway worker registration with derived staleness."""

    worker_id: str
    state: str
    started_at: str
    heartbeat_at: str
    catalog_sha256: str | None
    app_version: str | None
    stale: bool


class WorkersResponse(BaseModel):
    """The worker registry as the operator panel reads it."""

    workers: list[WorkerView]


class CatalogProviderView(BaseModel):
    """One provider behind an alias, with the lane this org's traffic rides."""

    provider: str
    lane: Literal["pass_through", "platform_funded"]


class CatalogAliasView(BaseModel):
    """One routable model slug as the requesting org resolves it."""

    alias: str
    # True for the org's own custom model (which shadows a public alias of
    # the same name for this org's keys).
    custom: bool
    revision_id: str
    refusal_failover: bool
    providers: list[CatalogProviderView]


class CatalogResponse(BaseModel):
    """The resolved alias list as one organization sees it."""

    org_id: str
    aliases: list[CatalogAliasView]


class _SnapshotDeployment(BaseModel):
    """The slice of a WMO catalog deployment the catalog view projects."""

    model_config = ConfigDict(extra="ignore")

    deployment_id: str
    provider: str
    billing_source: Literal["customer_managed", "host_managed"]


class _SnapshotPool(BaseModel):
    """The slice of a WMO exact-model pool the catalog view projects."""

    model_config = ConfigDict(extra="ignore")

    pool_id: str
    deployment_ids: list[str]


class _SnapshotDocument(BaseModel):
    """Typed boundary over a stored NormalizedGatewayCatalog document."""

    model_config = ConfigDict(extra="ignore")

    deployments: list[_SnapshotDeployment] = []
    pools: list[_SnapshotPool] = []


class _DirectTarget(BaseModel):
    """Typed boundary over an alias revision's stored DirectTarget."""

    model_config = ConfigDict(extra="ignore")

    kind: Literal["direct"]
    pool_id: str


def _require_org_member(client: SupabaseClient, actor: RequestActor, org_id: str) -> None:
    """Gate a gateway read on org membership."""
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.USER,
        not_found=f"Organization not found: {org_id}",
    )


def _date_or_400(value: str | None, name: str) -> str | None:
    """Reject a malformed date at the boundary: Postgres would 22008 -> 500."""
    if value is None:
        return None
    try:
        date.fromisoformat(value)
    except ValueError as error:
        msg = f"Invalid {name}: {value} (expected YYYY-MM-DD)"
        raise ApiError(msg, status_code=400) from error
    return value


def _int_row_value(row: JsonObject, column: str) -> int:
    """Read a required integer column out of an RPC row."""
    value = row.get(column)
    if isinstance(value, bool) or not isinstance(value, int):
        msg = f"gateway usage read returned a non-integer {column}"
        raise ApiError(msg, status_code=502)
    return value


@router.get("/usage/daily")
def get_usage_daily(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    scope: UsageScope = UsageScope.SELF,
    user_id: str | None = None,
    from_day: Annotated[str | None, Query(alias="from")] = None,
    to_day: Annotated[str | None, Query(alias="to")] = None,
    group_by: UsageGroupBy = UsageGroupBy.DAY,
    limit: int = 400,
) -> DailyUsageResponse:
    """Return the grouped gateway usage rollup for one organization.

    The account Overview page's read: ``scope=self&group_by=day`` is the
    acting user's daily {spend, tokens, requests} series (summed across all of
    the user's keys, all-time capable), ``scope=self&group_by=model`` its
    top-models list, and ``group_by=day_model`` the per-(day, alias) cells the
    stacked-by-model hero chart folds into top-N-plus-Other. ``scope=org``
    reads org-wide, optionally filtered to one member via ``user_id``. Each
    call is one indexed grouped query.
    """
    _require_org_member(client, actor, org_id)
    effective_user: str | None
    match scope:
        case UsageScope.SELF:
            if actor.api_key_org_id is not None:
                msg = "scope=self requires an end-user actor; API keys read scope=org"
                raise ApiError(msg, status_code=400)
            if user_id is not None and user_id != actor.user_id:
                msg = "user_id conflicts with scope=self (omit it or use scope=org)"
                raise ApiError(msg, status_code=400)
            effective_user = actor.user_id
        case UsageScope.ORG:
            effective_user = user_id
    result = client.rpc(
        "gateway_usage_daily_read",
        {
            "in_org": org_id,
            "in_user": effective_user,
            "in_from": _date_or_400(from_day, "from"),
            "in_to": _date_or_400(to_day, "to"),
            "in_group_by": group_by.value,
            "in_limit": min(max(limit, 1), _DAILY_LIMIT_CAP),
        },
    ).execute()
    rows = [
        DailyUsageRow(
            day=date.fromisoformat(str(row["day"])) if row.get("day") is not None else None,
            user_id=_projected_user_id(row.get("user_id")),
            alias=str(row["alias"]) if row.get("alias") is not None else None,
            requests=_int_row_value(row, "requests"),
            input_tokens=_int_row_value(row, "input_tokens"),
            output_tokens=_int_row_value(row, "output_tokens"),
            spend_micro_usd=_int_row_value(row, "spend_micro_usd"),
        )
        for row in result_rows(result)
    ]
    return DailyUsageResponse(org_id=org_id, scope=scope, group_by=group_by, rows=rows)


@router.get("/usage/platform-daily")
def get_usage_platform_daily(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    from_day: Annotated[str | None, Query(alias="from")] = None,
    to_day: Annotated[str | None, Query(alias="to")] = None,
    group_by: PlatformUsageGroupBy = PlatformUsageGroupBy.DAY,
    limit: int = 400,
) -> PlatformDailyUsageResponse:
    """Return the gateway usage rollup summed across every organization.

    The admin Telemetry section's read: ``group_by=day`` is the platform-wide
    daily {spend, tokens, requests} series, ``group_by=model`` its top-models
    list, and ``group_by=org`` the per-org breakdown. Operator surface only —
    non-admins get a 404, indistinguishable from an absent route. Per-org
    drilldowns reuse the tenant read (platform admins pass its org gate).
    """
    require_platform_admin(actor)
    result = client.rpc(
        "gateway_usage_platform_read",
        {
            "in_from": _date_or_400(from_day, "from"),
            "in_to": _date_or_400(to_day, "to"),
            "in_group_by": group_by.value,
            "in_limit": min(max(limit, 1), _DAILY_LIMIT_CAP),
        },
    ).execute()
    rows = [
        PlatformDailyUsageRow(
            day=date.fromisoformat(str(row["day"])) if row.get("day") is not None else None,
            org_id=str(row["org_id"]) if row.get("org_id") is not None else None,
            alias=str(row["alias"]) if row.get("alias") is not None else None,
            requests=_int_row_value(row, "requests"),
            input_tokens=_int_row_value(row, "input_tokens"),
            output_tokens=_int_row_value(row, "output_tokens"),
            spend_micro_usd=_int_row_value(row, "spend_micro_usd"),
        )
        for row in result_rows(result)
    ]
    return PlatformDailyUsageResponse(group_by=group_by, rows=rows)


def _projected_user_id(value: object) -> str | None:
    """Project a rollup user id, folding the unattributed bucket to null."""
    if value is None or str(value) == _UNATTRIBUTED_USER_ID:
        return None
    return str(value)


def _encode_events_cursor(row: JsonObject) -> str:
    """Mint the opaque keyset cursor pointing past one event row."""
    raw = f"{row['day']}|{row['created_at']}|{row['request_id']}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _decode_events_cursor(value: str) -> tuple[str, str, str]:
    """Decode and validate an events cursor, rejecting malformed input."""
    invalid = ApiError("Invalid cursor", status_code=400)
    try:
        raw = base64.urlsafe_b64decode(value.encode()).decode()
    except (binascii.Error, UnicodeDecodeError) as error:
        raise invalid from error
    parts = raw.split("|", 2)
    if len(parts) != 3 or not parts[2]:
        raise invalid
    cursor_day, cursor_created, cursor_request = parts
    try:
        date.fromisoformat(cursor_day)
        datetime.fromisoformat(cursor_created)
    except ValueError as error:
        raise invalid from error
    return cursor_day, cursor_created, cursor_request


@router.get("/usage/events")
def get_usage_events(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    api_key_id: str | None = None,
    from_day: Annotated[str | None, Query(alias="from")] = None,
    to_day: Annotated[str | None, Query(alias="to")] = None,
    cursor: str | None = None,
    limit: int = 50,
) -> UsageEventsResponse:
    """Return one page of the org's settled usage events, newest first.

    Keyset pagination (the events table is append-only and unbounded): pass
    the previous response's ``next_cursor`` back as ``cursor``. Org members
    read their own org only; platform admins read any org.
    """
    _require_org_member(client, actor, org_id)
    cursor_day, cursor_created, cursor_request = (
        _decode_events_cursor(cursor) if cursor is not None else (None, None, None)
    )
    cap = min(max(limit, 1), _EVENTS_LIMIT_CAP)
    result = client.rpc(
        "gateway_usage_events_read",
        {
            "in_org": org_id,
            "in_api_key": api_key_id,
            "in_from": _date_or_400(from_day, "from"),
            "in_to": _date_or_400(to_day, "to"),
            "in_cursor_day": cursor_day,
            "in_cursor_created": cursor_created,
            "in_cursor_request": cursor_request,
            "in_limit": cap,
        },
    ).execute()
    rows = result_rows(result)
    events = [
        UsageEventView(
            request_id=str(row["request_id"]),
            api_key_id=str(row["api_key_id"]) if row.get("api_key_id") is not None else None,
            user_id=_projected_user_id(row.get("user_id")),
            alias=str(row["alias"]),
            provider=str(row["provider"]) if row.get("provider") is not None else None,
            lane=_lane_or_none(row.get("lane")),
            input_tokens=_int_row_value(row, "input_tokens"),
            output_tokens=_int_row_value(row, "output_tokens"),
            cost_micro_usd=_int_row_value(row, "cost_micro_usd"),
            estimated_cost_micro_usd=_int_row_value(row, "estimated_cost_micro_usd"),
            latency_ms=(
                _int_row_value(row, "latency_ms") if row.get("latency_ms") is not None else None
            ),
            status=str(row["status"]),
            attempt_count=_int_row_value(row, "attempt_count"),
            day=date.fromisoformat(str(row["day"])),
            created_at=str(row["created_at"]),
        )
        for row in rows
    ]
    next_cursor = _encode_events_cursor(rows[-1]) if len(rows) == cap else None
    return UsageEventsResponse(org_id=org_id, events=events, next_cursor=next_cursor)


def _lane_or_none(value: object) -> Literal["pass_through", "platform_funded"] | None:
    """Validate a stored lane value at the typed boundary."""
    match value:
        case None:
            return None
        case "pass_through":
            return "pass_through"
        case "platform_funded":
            return "platform_funded"
        case _:
            msg = f"gateway usage event carries an unknown lane: {value!r}"
            raise ApiError(msg, status_code=502)


def _load_key_org(client: SupabaseClient, api_key_id: str) -> str:
    """Resolve an API key's owning org, or 404 without confirming existence.

    The not-found message matches the membership gate's, so a foreign org's
    key id is indistinguishable from an absent one.
    """
    row = find_one_by_columns(client, "api_keys", {"id": api_key_id})
    if row is None:
        msg = f"API key not found: {api_key_id}"
        raise ApiError(msg, status_code=404)
    return str(row["org_id"])


def _effective_key_limits(client: SupabaseClient, api_key_id: str) -> KeyLimitsView:
    """Read the key's effective guardrails through the lockstep RPC."""
    result = client.rpc("gateway_key_limits_effective", {"in_api_key": api_key_id}).execute()
    rows = result_rows(result)
    if not rows:
        msg = f"API key not found: {api_key_id}"
        raise ApiError(msg, status_code=404)
    row = rows[0]
    cap = row.get("daily_spend_cap_micro_usd")
    rpm = row.get("requests_per_minute")
    tpm = row.get("tokens_per_minute")
    source: Literal["explicit", "default"]
    match row.get("source"):
        case "explicit":
            source = "explicit"
        case "default":
            source = "default"
        case unknown:
            msg = f"gateway key limits read returned an unknown source: {unknown!r}"
            raise ApiError(msg, status_code=502)
    return KeyLimitsView(
        api_key_id=api_key_id,
        daily_spend_cap_micro_usd=(
            _int_row_value(row, "daily_spend_cap_micro_usd") if cap is not None else None
        ),
        requests_per_minute=(
            _int_row_value(row, "requests_per_minute") if rpm is not None else None
        ),
        tokens_per_minute=(_int_row_value(row, "tokens_per_minute") if tpm is not None else None),
        source=source,
    )


@router.get("/keys/{api_key_id}/limits")
def get_key_limits(
    api_key_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> KeyLimitsView:
    """Return one key's effective guardrails, defaults included.

    Readable at member strength so a key can self-serve its own limits; the
    write below stays admin-gated like every other spend control.
    """
    org_id = _load_key_org(client, api_key_id)
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.USER,
        not_found=f"API key not found: {api_key_id}",
    )
    return _effective_key_limits(client, api_key_id)


@router.put("/keys/{api_key_id}/limits")
def put_key_limits(
    api_key_id: str,
    body: KeyLimitsRequest,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> KeyLimitsView:
    """Set one key's guardrails (org admin; this authorizes real dollars).

    Full-resource semantics: the row becomes exactly the body, so omitted
    fields mean explicitly uncapped rather than "keep the old value". The
    worker's reservation path reads the row on the next dispatch.
    """
    org_id = _load_key_org(client, api_key_id)
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.ADMIN,
        not_found=f"API key not found: {api_key_id}",
    )
    client.table("gateway_key_limits").upsert(
        {
            "api_key_id": api_key_id,
            "daily_spend_cap_micro_usd": body.daily_spend_cap_micro_usd,
            "requests_per_minute": body.requests_per_minute,
            "tokens_per_minute": body.tokens_per_minute,
            "updated_at": datetime.now(tz=UTC).isoformat(),
        },
        on_conflict="api_key_id",
    ).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.KEYS_LIMITS_SET,
        object_type="api_key",
        object_id=api_key_id,
        after={
            "daily_spend_cap_micro_usd": body.daily_spend_cap_micro_usd,
            "requests_per_minute": body.requests_per_minute,
        },
    )
    return _effective_key_limits(client, api_key_id)


@router.get("/workers")
def list_workers(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> WorkersResponse:
    """Return the worker registry with derived staleness (platform admin).

    Cross-tenant operator surface: 404 for everyone else, like the runs
    panel. ``stale`` means the heartbeat is older than 60s — presumed dead or
    partitioned, pending the crash reconciler.
    """
    require_platform_admin(actor)
    result = client.table("gateway_workers").select("*").order("started_at", desc=True).execute()
    now = datetime.now(tz=UTC)
    workers = [
        WorkerView(
            worker_id=str(row["worker_id"]),
            state=str(row["state"]),
            started_at=str(row["started_at"]),
            heartbeat_at=str(row["heartbeat_at"]),
            catalog_sha256=(
                str(row["catalog_sha256"]) if row.get("catalog_sha256") is not None else None
            ),
            app_version=str(row["app_version"]) if row.get("app_version") is not None else None,
            stale=_heartbeat_stale(row.get("heartbeat_at"), now),
        )
        for row in result.data
    ]
    return WorkersResponse(workers=workers)


def _heartbeat_stale(heartbeat_at: object, now: datetime) -> bool:
    """Whether a heartbeat timestamp is missing, unparseable, or too old."""
    if not isinstance(heartbeat_at, str):
        return True
    try:
        beat = datetime.fromisoformat(heartbeat_at)
    except ValueError:
        return True
    if beat.tzinfo is None:
        beat = beat.replace(tzinfo=UTC)
    return now - beat > _WORKER_STALE_AFTER


@router.get("/catalog")
def get_catalog(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> CatalogResponse:
    """Return the resolved alias list as this organization sees it.

    Public catalog entries plus the org's own custom models, with the org's
    shadowing applied (an org alias hides the public alias of the same name,
    matching the worker's lookup rule). Each alias carries its providers and
    the lane this org's traffic rides per provider: ``pass_through`` when the
    org holds a BYOK connection for the provider or the deployment itself is
    customer-managed, ``platform_funded`` otherwise. Deployment and pool ids
    are server-internal and deliberately not serialized.
    """
    _require_org_member(client, actor, org_id)
    public_rows = (
        client.table("gateway_aliases")
        .select("*")
        .eq("active", True)  # noqa: FBT003 - supabase eq() is positional-only
        .is_("org_id", "null")
        .execute()
        .data
    )
    org_rows = (
        client.table("gateway_aliases")
        .select("*")
        .eq("active", True)  # noqa: FBT003 - supabase eq() is positional-only
        .eq("org_id", org_id)
        .execute()
        .data
    )
    # Org rows win: inserting them second overwrites a same-named public row.
    by_name: dict[str, JsonObject] = {str(row["alias_name"]): dict(row) for row in public_rows}
    by_name.update({str(row["alias_name"]): dict(row) for row in org_rows})
    # A row with no current revision was never activated (unreachable through
    # the sanctioned write path); it is not routable, so it is not resolved.
    resolvable = {
        name: row for name, row in by_name.items() if row.get("current_revision_id") is not None
    }
    revisions = _rows_by_key(
        client,
        "gateway_alias_revisions",
        "revision_id",
        {str(row["current_revision_id"]) for row in resolvable.values()},
    )
    snapshots = _rows_by_key(
        client,
        "gateway_catalog_snapshots",
        "catalog_sha256",
        {str(row["catalog_sha256"]) for row in revisions.values()},
    )
    byok_providers = {
        str(row["provider"])
        for row in (
            client.table("provider_connections").select("provider").eq("org_id", org_id).execute()
        ).data
    }
    aliases: list[CatalogAliasView] = []
    for name in sorted(resolvable):
        row = resolvable[name]
        revision = revisions[str(row["current_revision_id"])]
        document = _SnapshotDocument.model_validate(
            snapshots[str(revision["catalog_sha256"])]["document"]
        )
        target = _DirectTarget.model_validate(revision["target"])
        aliases.append(
            CatalogAliasView(
                alias=name,
                custom=row.get("org_id") is not None,
                revision_id=str(revision["revision_id"]),
                refusal_failover=bool(revision["refusal_failover"]),
                providers=_alias_providers(document, target.pool_id, byok_providers),
            )
        )
    return CatalogResponse(org_id=org_id, aliases=aliases)


def _rows_by_key(
    client: SupabaseClient,
    table: str,
    key: str,
    values: set[str],
) -> dict[str, JsonObject]:
    """Fetch rows by key set and index them; absent keys fail at lookup.

    Foreign keys guarantee every referenced revision and snapshot row exists,
    so a missing entry here is data corruption and the KeyError is the loud
    failure it deserves.
    """
    if not values:
        return {}
    result = client.table(table).select("*").in_(key, sorted(values)).execute()
    return {str(row[key]): dict(row) for row in result.data}


def _alias_providers(
    document: _SnapshotDocument,
    pool_id: str,
    byok_providers: set[str],
) -> list[CatalogProviderView]:
    """Resolve an alias pool into per-provider lanes in waterfall order."""
    pools = {pool.pool_id: pool for pool in document.pools}
    deployments = {deployment.deployment_id: deployment for deployment in document.deployments}
    pool = pools.get(pool_id)
    if pool is None:
        msg = f"alias revision names a pool absent from its catalog snapshot: {pool_id}"
        raise ApiError(msg, status_code=502)
    providers: list[CatalogProviderView] = []
    seen: set[str] = set()
    for deployment_id in pool.deployment_ids:
        deployment = deployments.get(deployment_id)
        if deployment is None:
            msg = f"catalog snapshot is missing pool deployment: {deployment_id}"
            raise ApiError(msg, status_code=502)
        if deployment.provider in seen:
            continue
        seen.add(deployment.provider)
        pass_through = (
            deployment.provider in byok_providers or deployment.billing_source == "customer_managed"
        )
        providers.append(
            CatalogProviderView(
                provider=deployment.provider,
                lane="pass_through" if pass_through else "platform_funded",
            )
        )
    return providers


class WhoamiResponse(BaseModel):
    """The organization the presented credential acts for."""

    org_id: str
    org_slug: str
    org_name: str


@whoami_router.get("/whoami")
def whoami(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> WhoamiResponse:
    """Return the organization the caller's credential acts for.

    The first call in an agent's setup flow: an ``xpl_`` org key resolves to
    exactly its organization (a bad or absent key never reaches this handler —
    the bearer middleware answers 401). A session actor resolves to their sole
    membership; an actor spanning several orgs (multiple memberships, or a
    platform admin, who acts across every org) has no single answer, so the
    409 names the fix rather than guessing.
    """
    org_id = resolve_acting_org(client, actor)
    row = find_one_by_columns(client, "organizations", {"id": org_id})
    if row is None:
        msg = f"Organization not found: {org_id}"
        raise ApiError(msg, status_code=404)
    return WhoamiResponse(
        org_id=str(row["id"]),
        org_slug=str(row["slug"]),
        org_name=str(row["name"]),
    )
