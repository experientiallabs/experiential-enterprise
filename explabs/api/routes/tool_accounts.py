# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tool-account balance management: declare, fetch, connect, disconnect.

Tool accounts are spend-visibility-only vendor accounts (E2B, Greptile, Cursor,
Devin) an org tracks a remaining-credit balance for on /credits. They are NOT
model providers: they never route through the gateway and never enter the
catalog. E2B is visible to every org; Greptile, Cursor, and Devin are gated to
YC companies — an org without the ``yc`` label gets the resource 404 for those
vendors, preserving the inference-only scope every non-YC org already has.

The manual-declare + drawdown mirror the provider_connections balance gauge; the
"Fetch balance" action runs the pluggable balance fetcher (a deterministic
vendor billing API where one exists — Cursor — otherwise the computer-use agent,
which is stubbed pending sign-off). Any dashboard-login credential lives in
Vault and is released only into a deterministic fetch, never returned.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from explabs.api.routes import ApiError, get_supabase
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.db.stores.tool_account_store import (
    YC_GATED_TOOL_VENDORS,
    BalanceSource,
    FetchStatus,
    ToolAccountRecord,
    ToolAccountStore,
    TrackedToolVendor,
)
from explabs.db.stores.yc_claim_store import YcClaimStore
from explabs.providers.balance_fetch import (
    TOOL_VENDOR_STRATEGY,
    BalanceFetchKind,
    BalanceFetchStrategy,
    build_tool_fetcher,
)

router = APIRouter(prefix="/api", tags=["tool accounts"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]

# The order tool-account cards render in on /credits: E2B first (visible to
# everyone), then the YC-gated vendors.
_VENDOR_ORDER: tuple[TrackedToolVendor, ...] = (
    TrackedToolVendor.E2B,
    TrackedToolVendor.GREPTILE,
    TrackedToolVendor.CURSOR,
    TrackedToolVendor.DEVIN,
)


class ToolAccountView(BaseModel):
    """The customer-safe projection of one tool account (no secrets, no ids)."""

    model_config = ConfigDict(frozen=True)

    vendor: TrackedToolVendor
    connected: bool
    yc_gated: bool
    config: JsonObject | None
    credential_last4: str | None
    declared_balance_usd: float | None
    declared_balance_set_at: str | None
    balance_source: BalanceSource | None
    low_balance_threshold_usd: float
    last_fetch_at: str | None
    last_fetch_status: FetchStatus | None
    last_fetch_message: str | None

    @classmethod
    def of(cls, vendor: TrackedToolVendor, record: ToolAccountRecord | None) -> ToolAccountView:
        """Project a row (or its absence) onto the public shape."""
        yc_gated = vendor in YC_GATED_TOOL_VENDORS
        if record is None:
            return cls(
                vendor=vendor,
                connected=False,
                yc_gated=yc_gated,
                config=None,
                credential_last4=None,
                declared_balance_usd=None,
                declared_balance_set_at=None,
                balance_source=None,
                low_balance_threshold_usd=5.0,
                last_fetch_at=None,
                last_fetch_status=None,
                last_fetch_message=None,
            )
        return cls(
            vendor=vendor,
            connected=True,
            yc_gated=yc_gated,
            config=record.config,
            credential_last4=record.credential_last4,
            declared_balance_usd=record.declared_balance_usd,
            declared_balance_set_at=record.declared_balance_set_at,
            balance_source=record.balance_source,
            low_balance_threshold_usd=record.low_balance_threshold_usd,
            last_fetch_at=record.last_fetch_at,
            last_fetch_status=record.last_fetch_status,
            last_fetch_message=record.last_fetch_message,
        )


class ToolAccountUpsertRequest(BaseModel):
    """One declare/connect request: any of the balance, threshold, or secret."""

    model_config = ConfigDict(extra="forbid")

    # Present-and-null turns tracking off; absent leaves it unchanged.
    declared_balance_usd: float | None = None
    low_balance_threshold_usd: float | None = None
    # The optional dashboard-login credential (goes straight to Vault).
    dashboard_secret: str | None = None


class ToolBalanceFetchResult(BaseModel):
    """The outcome of one tool-account balance fetch."""

    model_config = ConfigDict(frozen=True)

    vendor: TrackedToolVendor
    kind: BalanceFetchKind
    strategy: BalanceFetchStrategy
    refreshed: bool
    balance_usd: float | None
    source: BalanceSource | None
    message: str


@router.get("/orgs/{org_id}/tool-accounts", response_model=list[ToolAccountView])
def list_tool_accounts(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> list[ToolAccountView]:
    """List the tool accounts the org may see (E2B always; YC vendors if YC)."""
    require_org_role(
        client, actor, org_id, OrgRole.USER, not_found=f"Organization not found: {org_id}"
    )
    store = ToolAccountStore(client)
    records = {record.vendor: record for record in store.list_for_org(org_id)}
    is_yc = _org_is_yc_company(client, org_id)
    return [
        ToolAccountView.of(vendor, records.get(vendor))
        for vendor in _VENDOR_ORDER
        if not (vendor in YC_GATED_TOOL_VENDORS and not is_yc)
    ]


@router.put("/orgs/{org_id}/tool-accounts/{vendor}", response_model=ToolAccountView)
def upsert_tool_account(
    org_id: str,
    vendor: str,
    body: ToolAccountUpsertRequest,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> ToolAccountView:
    """Declare a balance, set a threshold, and/or store a dashboard credential."""
    tracked = _vendor(vendor)
    _require_manager(client, actor, org_id, tracked)
    store = ToolAccountStore(client)

    if body.dashboard_secret is not None:
        secret = body.dashboard_secret.strip()
        if len(secret) < 12:
            msg = "The dashboard credential is too short to be a real credential."
            raise ApiError(msg, status_code=400)
        store.set_credential(
            org_id=org_id,
            vendor=tracked,
            credential=secret,
            actor=actor.user_id,
        )

    if "declared_balance_usd" in body.model_fields_set:
        balance = body.declared_balance_usd
        if balance is not None and balance < 0:
            msg = "The declared balance cannot be negative."
            raise ApiError(msg, status_code=400)
        threshold = body.low_balance_threshold_usd
        if threshold is not None and threshold < 0:
            msg = "The low-balance threshold cannot be negative."
            raise ApiError(msg, status_code=400)
        store.set_declared_balance(
            org_id=org_id,
            vendor=tracked,
            balance_usd=balance,
            low_balance_threshold_usd=threshold,
            actor=actor.user_id,
        )

    record = store.find(org_id, tracked)
    return ToolAccountView.of(tracked, record)


@router.post(
    "/orgs/{org_id}/tool-accounts/{vendor}/fetch-balance",
    response_model=ToolBalanceFetchResult,
)
def fetch_tool_account_balance(
    org_id: str,
    vendor: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> ToolBalanceFetchResult:
    """Run the vendor's balance fetcher and update the tracked balance.

    A deterministic vendor billing API is read with the stored credential
    (released only here, never returned); an API-less vendor routes to the
    computer-use agent, which is stubbed to a ``pending`` reading until its
    security model is signed off — no credential is released on that path.
    """
    tracked = _vendor(vendor)
    _require_manager(client, actor, org_id, tracked)
    store = ToolAccountStore(client)
    account = store.ensure(org_id=org_id, vendor=tracked, actor=actor.user_id)

    credential: str | None = None
    if (
        TOOL_VENDOR_STRATEGY[tracked] is BalanceFetchStrategy.DETERMINISTIC
        and account.credential_last4 is not None
    ):
        credential = store.release_credential(account.id)
    fetcher = build_tool_fetcher(tracked, credential=credential, config=account.config)
    reading = fetcher.fetch()

    store.record_fetch(
        org_id=org_id,
        vendor=tracked,
        status=FetchStatus(reading.kind.value),
        message=reading.message,
        balance_usd=reading.balance_usd,
        source=reading.source,
    )
    return ToolBalanceFetchResult(
        vendor=tracked,
        kind=reading.kind,
        strategy=reading.strategy,
        refreshed=reading.kind is BalanceFetchKind.REPORTED,
        balance_usd=reading.balance_usd,
        source=reading.source,
        message=reading.message,
    )


@router.delete("/orgs/{org_id}/tool-accounts/{vendor}")
def delete_tool_account(
    org_id: str,
    vendor: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Disconnect one tool account (drops the row and any Vault secret)."""
    tracked = _vendor(vendor)
    _require_manager(client, actor, org_id, tracked)
    removed = ToolAccountStore(client).delete(org_id, tracked)
    return {"deleted": removed}


def _vendor(vendor: str) -> TrackedToolVendor:
    """The path segment as a tracked vendor, or the enumerated 400."""
    try:
        return TrackedToolVendor(vendor)
    except ValueError:
        vendors = ", ".join(member.value for member in TrackedToolVendor)
        msg = f"vendor must be one of: {vendors}."
        raise ApiError(msg, status_code=400) from None


def _require_manager(
    client: SupabaseClient, actor: RequestActor, org_id: str, vendor: TrackedToolVendor
) -> None:
    """Org-admin gate plus the YC gate for the YC-only vendors.

    A YC-gated vendor on a non-YC org answers the resource 404 (never a 403),
    so the vendor's existence is not confirmed to an org that may not track it —
    the same not-found convention the provider routes use for a foreign org.
    """
    not_found = f"Tool account not found: {vendor.value}"
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=not_found)
    if vendor in YC_GATED_TOOL_VENDORS and not _org_is_yc_company(client, org_id):
        raise ApiError(not_found, status_code=404)


def _org_is_yc_company(client: SupabaseClient, org_id: str) -> bool:
    """Whether the org is a YC company: it carries the ``yc`` org label.

    The generalized label (``public.org_labels``) is the YC-company source of
    truth; presence marks a YC company independent of grant expiry, so a YC org
    keeps its tool-account cards after the launch grant lapses.
    """
    return YcClaimStore(client).is_yc_company(org_id)
