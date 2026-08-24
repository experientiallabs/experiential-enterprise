# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Provider connection management: connect/rotate, verification, spend reads.

Three routes. The PUT connects or rotates an org's BYOK credential and runs
the hookup check in the same round-trip ("bring up health when they first
hook it up"); afterwards only real traffic updates the status — there is no
manual recheck surface by design. The check probes a stored credential and
persists the verdict (the web PUT calls it through the deployment bearer).
The spend refresh reads what the provider account can report, records it as
a ``provider_account_snapshots`` row, and enforces per-provider staleness
floors so refreshing "quite often" stays cheap-safe. A fourth route, the
deployment check, answers the model page's Azure question — "you have a key,
but is THIS model deployed?" — optionally mapping the deployment name first
(the least-clicks inline add), and persists the model-scoped fact under
``status_detail.models`` without touching the key-level status.

All are management-plane platform endpoints only: they NEVER route through
the gateway/serving path. Per Contract 3 the first three are also the public
management API for org-API-key bearers (the /yc agent flow hooks up the
human's provider accounts with nothing but an ``xpl_`` key), so their gate
admits a key actor for exactly its own org — see ``_require_manager``. The
deployment check stays session-admin only (not in the customer-key
allowlist): a human maps and probes Azure deployments from the model page.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.routes import ApiError, get_supabase
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.db.stores.provider_connection_store import (
    AzureConnectionConfig,
    BedrockConnectionConfig,
    ConnectableProvider,
    ConnectionStatus,
    ConnectionStatusSource,
    FireworksConnectionConfig,
    ProviderConnectionRecord,
    ProviderConnectionStore,
)
from explabs.db.stores.provider_snapshot_store import (
    ProviderAccountSnapshot,
    ProviderSnapshotStore,
    SnapshotSource,
)
from explabs.providers.accounts import masked, probe_connection
from explabs.providers.anthropic import ADMIN_KEY_PREFIX as ANTHROPIC_ADMIN_KEY_PREFIX
from explabs.providers.modal import ModalTokenPair
from explabs.providers.openai import ADMIN_KEY_PREFIX as OPENAI_ADMIN_KEY_PREFIX
from explabs.providers.spend import (
    SPEND_REFRESH_FLOOR_SECONDS,
    SpendReportKind,
    read_spend,
)

router = APIRouter(prefix="/api", tags=["provider connections"])

# Org-API-key bearers reach the three management routes (PUT, check,
# spend-refresh) via the _CUSTOMER_KEY_ROUTES allowlist in explabs/api/app.py
# (Contract 3: the /yc agent flow hooks up a human's provider accounts with
# nothing but an xpl_ key). The tenancy below admits a key actor for its own
# org at user strength; the session path (deployment bearer + actor header) is
# unchanged.

Actor = Annotated[RequestActor, Depends(get_request_actor)]

# The providers whose spend read needs the optional admin key rather than the
# main credential; without one stored, the read is the honest empty state and
# no secret is released at all.
_ADMIN_KEY_SPEND_PROVIDERS = frozenset({ConnectableProvider.ANTHROPIC, ConnectableProvider.OPENAI})
# The providers that are never queried for spend (nothing is reportable), so
# the refresh answers immediately without releasing any secret.
_NEVER_REPORTABLE_PROVIDERS = frozenset(
    {ConnectableProvider.GEMINI, ConnectableProvider.AZURE_OPENAI}
)


class ConnectionCheckResult(BaseModel):
    """The persisted verdict of one hookup check (never any key material)."""

    model_config = ConfigDict(frozen=True)

    provider: ConnectableProvider
    status: ConnectionStatus
    status_detail: JsonObject | None
    status_checked_at: str | None
    status_source: ConnectionStatusSource | None


class ConnectionUpsertRequest(BaseModel):
    """One connect/rotate request: the secret plus non-secret provider config."""

    model_config = ConfigDict(extra="forbid")

    # Modal sends its token pair; every other provider sends the key string.
    secret: str | ModalTokenPair
    config: JsonObject = Field(default_factory=dict)
    # The optional provider ADMIN key (anthropic/openai only), spend reads only.
    spend_secret: str | None = None


class ConnectionView(BaseModel):
    """The customer-safe projection of one connection (no ids, no secrets)."""

    model_config = ConfigDict(frozen=True)

    provider: ConnectableProvider
    config: JsonObject
    credential_last4: str | None
    spend_credential_last4: str | None

    @classmethod
    def of(cls, record: ProviderConnectionRecord) -> ConnectionView:
        """Project a store record onto the public shape."""
        return cls(
            provider=record.provider,
            config=record.config,
            credential_last4=record.credential_last4,
            spend_credential_last4=record.spend_credential_last4,
        )


class ConnectionUpsertResult(BaseModel):
    """A saved connection plus the hookup check's verdict, in one round-trip."""

    model_config = ConfigDict(frozen=True)

    connection: ConnectionView
    check: ConnectionCheckResult


@router.get(
    "/orgs/{org_id}/provider-connections",
    response_model=list[ConnectionView],
)
def list_provider_connections(
    org_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> list[ConnectionView]:
    """List an org's BYOK provider connections (config + last4, never secrets).

    The management read of Contract 3: an agent holding only the org's ``xpl_``
    key sees which providers are connected and their non-secret config, mirroring
    the web settings list. Read strength (``USER``) — a key actor reads its own
    org, and a foreign org gets the resource 404, never a 403 that would confirm
    it exists.
    """
    require_org_role(
        client, actor, org_id, OrgRole.USER, not_found=f"Organization not found: {org_id}"
    )
    store = ProviderConnectionStore(client)
    return [ConnectionView.of(record) for record in store.list_for_org(org_id)]


@router.put(
    "/orgs/{org_id}/provider-connections/{provider}",
    response_model=ConnectionUpsertResult,
)
def put_provider_connection(
    org_id: str,
    provider: str,
    body: ConnectionUpsertRequest,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> ConnectionUpsertResult:
    """Connect or rotate one provider credential and verify it inline.

    The management write of Contract 3: an agent holding only the org's
    ``xpl_`` API key hooks up the human's provider account here, mirroring the
    web settings PUT exactly — same config validation, same secret handling
    (straight to Vault, never echoed), same one-round-trip hookup check.
    """
    connectable = _connectable(provider)
    _require_manager(client, actor, org_id, provider)
    secret = _normalized_secret(connectable, body.secret)
    spend_secret = _normalized_spend_secret(connectable, body.spend_secret)
    config = _normalized_config(connectable, body.config)
    store = ProviderConnectionStore(client)
    store.upsert(
        org_id=org_id,
        provider=connectable,
        config=config,
        credential=secret,
        actor=actor.user_id,
    )
    if spend_secret is not None:
        # Stored after the main key so a fresh connection exists to ride; the
        # hookup check below then verifies BOTH credentials in one pass and
        # reports the admin key's verdict under status_detail.spend_key.
        store.set_spend_credential(
            org_id=org_id,
            provider=connectable,
            credential=spend_secret,
            actor=actor.user_id,
        )
    # Re-read so the checked record carries the spend-credential state the
    # writes above just produced.
    record = store.find(org_id, connectable)
    if record is None:  # pragma: no cover - the upsert either wrote or raised
        msg = f"Provider connection not found: {provider}"
        raise ApiError(msg, status_code=404)
    check, updated = _run_hookup_check(store, record)
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.BYOK_UPSERT,
        object_type="provider_connection",
        object_id=connectable.value,
        after={"provider": connectable.value, "config": config, "status": check.status.value},
    )
    return ConnectionUpsertResult(connection=ConnectionView.of(updated), check=check)


def _normalized_secret(connectable: ConnectableProvider, secret: str | ModalTokenPair) -> str:
    """The Vault-bound secret string, refused before storage when malformed."""
    if connectable is ConnectableProvider.MODAL:
        if not isinstance(secret, ModalTokenPair):
            msg = (
                "Modal takes the token PAIR, not a single key: send secret as "
                '{"token_id": "ak-…", "token_secret": "as-…"} from modal.com → '
                "Settings → API tokens."
            )
            raise ApiError(msg, status_code=400)
        return secret.model_dump_json()
    if isinstance(secret, ModalTokenPair):
        msg = f"{connectable.value} takes a single API key string, not a token pair."
        raise ApiError(msg, status_code=400)
    trimmed = secret.strip()
    if not trimmed:
        noun = "A secret access key" if connectable is ConnectableProvider.BEDROCK else "An API key"
        msg = f"{noun} is required."
        raise ApiError(msg, status_code=400)
    # credential_last4 is member-readable; the RPC enforces the same floor,
    # but a typed 400 beats its opaque 500.
    if len(trimmed) < 12:
        msg = "The provider credential is too short to be a real API key."
        raise ApiError(msg, status_code=400)
    # An ADMIN key in the main slot would save fine and then fail every
    # inference call; refuse it before anything is stored, naming both types.
    if connectable is ConnectableProvider.ANTHROPIC and trimmed.startswith(
        ANTHROPIC_ADMIN_KEY_PREFIX
    ):
        msg = (
            f"The key ending {masked(trimmed)} is an Anthropic ADMIN key (sk-ant-admin…) "
            "— it cannot do inference. Put the inference key (sk-ant-api…) in secret and "
            "the admin key in spend_secret."
        )
        raise ApiError(msg, status_code=400)
    if connectable is ConnectableProvider.OPENAI and trimmed.startswith(OPENAI_ADMIN_KEY_PREFIX):
        msg = (
            f"The key ending {masked(trimmed)} is an OpenAI ADMIN key (sk-admin-…) — it "
            "cannot do inference. Put the project/inference key (sk-…) in secret and the "
            "admin key in spend_secret."
        )
        raise ApiError(msg, status_code=400)
    return trimmed


def _normalized_spend_secret(
    connectable: ConnectableProvider, spend_secret: str | None
) -> str | None:
    """The optional admin key, prefix-checked so a swapped key is named."""
    if spend_secret is None:
        return None
    if connectable not in _ADMIN_KEY_SPEND_PROVIDERS:
        msg = "Only Anthropic and OpenAI connections take an admin key for spend."
        raise ApiError(msg, status_code=400)
    trimmed = spend_secret.strip()
    if not trimmed:
        msg = "An admin key is required when one is provided."
        raise ApiError(msg, status_code=400)
    prefix = (
        ANTHROPIC_ADMIN_KEY_PREFIX
        if connectable is ConnectableProvider.ANTHROPIC
        else OPENAI_ADMIN_KEY_PREFIX
    )
    if not trimmed.startswith(prefix):
        # The two key types are disjoint (live-tested); name the swap.
        msg = (
            f"The key ending {masked(trimmed)} is not a {connectable.value} ADMIN key "
            f"({prefix}…) — the admin and inference key types are disjoint. The "
            "inference key belongs in secret."
        )
        raise ApiError(msg, status_code=400)
    return trimmed


def _normalized_config(connectable: ConnectableProvider, config: JsonObject) -> JsonObject:
    """The non-secret config in its provider's typed shape.

    Azure, Bedrock, and Fireworks carry required config; the key-only
    providers bill off the key alone, so anything they send is dropped rather
    than stored — exactly the web PUT's semantics.
    """
    match connectable:
        case ConnectableProvider.AZURE_OPENAI:
            validated = _validated_config(AzureConnectionConfig, connectable, config)
            # Same refusal as the web PUT: a config that names no deployment
            # can hold a valid key and still route nothing.
            if not validated.get("deployments"):
                msg = (
                    "Invalid azure_openai config — deployments: add at least one "
                    "model-to-deployment mapping so requests have somewhere to go."
                )
                raise ApiError(msg, status_code=400)
            return validated
        case ConnectableProvider.BEDROCK:
            return _validated_config(BedrockConnectionConfig, connectable, config)
        case ConnectableProvider.FIREWORKS:
            return _validated_config(FireworksConnectionConfig, connectable, config)
        case _:
            return {}


def _validated_config(
    shape: type[BaseModel], connectable: ConnectableProvider, config: JsonObject
) -> JsonObject:
    """One config through its typed shape, or a 400 naming what is wrong."""
    try:
        validated = shape.model_validate(config)
    except ValidationError as error:
        problems = "; ".join(
            f"{'.'.join(str(part) for part in issue['loc']) or 'config'}: {issue['msg']}"
            for issue in error.errors()
        )
        msg = f"Invalid {connectable.value} config — {problems}."
        raise ApiError(msg, status_code=400) from error
    return validated.model_dump(exclude_none=True)


@router.post(
    "/orgs/{org_id}/provider-connections/{provider}/check",
    response_model=ConnectionCheckResult,
)
def check_provider_connection(
    org_id: str,
    provider: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> ConnectionCheckResult:
    """Probe one stored credential at its provider and persist the verdict.

    The Vault secret is released only into the probe call and never returned;
    the response carries the canonical status plus the verbose provider
    detail (raw code, raw message, our remediation text). When the connection
    also stores an admin key, that key is probed in the same pass and its own
    verdict rides ``status_detail.spend_key``.
    """
    connectable = _connectable(provider)
    _require_manager(client, actor, org_id, provider)
    store = ProviderConnectionStore(client)
    record = store.find(org_id, connectable)
    if record is None:
        msg = f"Provider connection not found: {provider}"
        raise ApiError(msg, status_code=404)
    check, _updated = _run_hookup_check(store, record)
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.BYOK_STATUS_CHECK,
        object_type="provider_connection",
        object_id=connectable.value,
        after={"provider": connectable.value, "status": check.status.value},
    )
    return check


def _run_hookup_check(
    store: ProviderConnectionStore, record: ProviderConnectionRecord
) -> tuple[ConnectionCheckResult, ProviderConnectionRecord]:
    """Probe the connection (and any stored admin key), persist the verdict."""
    try:
        result = probe_connection(record, store.release_credential(record.id))
    except ValidationError as error:
        # A stored config the typed shape refuses is our data problem, not
        # the provider's; surface it rather than misreporting the key.
        msg = f"The stored {record.provider.value} connection config is malformed: {error}"
        raise ApiError(msg, status_code=500) from error
    detail = result.detail.model_dump()
    spend_key_detail = _probe_spend_key(store, record)
    if spend_key_detail is not None:
        detail["spend_key"] = spend_key_detail
    updated = store.record_status(
        record.id,
        status=result.status,
        detail=detail,
        source=ConnectionStatusSource.HOOKUP_CHECK,
        for_credential_last4=record.credential_last4,
    )
    check = ConnectionCheckResult(
        provider=updated.provider,
        status=updated.status,
        status_detail=updated.status_detail,
        status_checked_at=updated.status_checked_at,
        status_source=updated.status_source,
    )
    return check, updated


def _probe_spend_key(
    store: ProviderConnectionStore, record: ProviderConnectionRecord
) -> JsonObject | None:
    """The stored admin key's own verdict, when the connection carries one.

    The admin key never serves traffic, so its verdict is scoped under
    ``status_detail.spend_key`` and never touches the key-level status.
    """
    if record.provider not in _ADMIN_KEY_SPEND_PROVIDERS or record.spend_credential_last4 is None:
        return None
    from explabs.providers import anthropic, openai

    credential = store.release_spend_credential(record.id)
    match record.provider:
        case ConnectableProvider.ANTHROPIC:
            verdict = anthropic.probe_spend_key(credential)
        case ConnectableProvider.OPENAI:
            verdict = openai.probe_spend_key(credential)
        case _:
            return None
    return {
        "status": verdict.status.value,
        "checked_at": datetime.now(tz=UTC).isoformat(),
        **verdict.detail.model_dump(),
    }


class DeploymentCheckRequest(BaseModel):
    """One model's deployment question, with the optional inline mapping."""

    model_config = ConfigDict(extra="forbid")

    # The catalog model slug the fact is scoped to — the same key the Azure
    # config's deployment map uses.
    model: str = Field(min_length=1)
    # When present, saved as the model's deployment mapping before probing:
    # the model page's "just the deployment name" inline add.
    deployment: str | None = Field(default=None, min_length=1)


class DeploymentCheckResult(BaseModel):
    """One (connection x model) deployment fact (never any key material)."""

    model_config = ConfigDict(frozen=True)

    provider: ConnectableProvider
    model: str
    deployment: str
    deployed: bool
    checked_at: str
    # The probe's verbose capture (provider status/code/message, remediation).
    detail: JsonObject


@router.post(
    "/orgs/{org_id}/provider-connections/{provider}/deployment-check",
    response_model=DeploymentCheckResult,
)
def check_model_deployment(
    org_id: str,
    provider: str,
    body: DeploymentCheckRequest,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> DeploymentCheckResult:
    """Probe whether one model's mapped Azure deployment exists on the resource.

    Azure addresses deployments rather than model ids, so a valid key alone
    cannot answer "can this key serve this model". This route resolves the
    model's mapped deployment name (mapping it first when the body carries
    one), runs the one-token probe from the hookup service, and persists the
    verdict under ``status_detail.models`` — the canonical "you have a key,
    but this model isn't deployed" fact. The key-level status is not touched.
    """
    connectable = _connectable(provider)
    if connectable is not ConnectableProvider.AZURE_OPENAI:
        msg = (
            "Per-model deployment checks exist only for azure_openai; "
            f"{provider} addresses models directly, so a valid key already serves them."
        )
        raise ApiError(msg, status_code=400)
    _require_manager(client, actor, org_id, provider)
    store = ProviderConnectionStore(client)
    record = store.find(org_id, connectable)
    if record is None:
        msg = f"Provider connection not found: {provider}"
        raise ApiError(msg, status_code=404)
    model = body.model.strip()
    if not model:
        msg = "model must name the catalog model slug the deployment serves."
        raise ApiError(msg, status_code=422)
    if body.deployment is not None:
        record = _map_deployment(store, record, model=model, deployment=body.deployment.strip())
    try:
        azure = record.azure_config()
    except ValidationError as error:
        msg = f"The stored {provider} connection config is malformed: {error}"
        raise ApiError(msg, status_code=500) from error
    deployment = azure.deployments.get(model)
    if deployment is None:
        msg = (
            f"No Azure deployment is mapped for model '{model}' on this connection; "
            "pass `deployment` to map the deployment name it is served under."
        )
        raise ApiError(msg, status_code=404)
    from explabs.providers import azure_openai

    try:
        verdict = azure_openai.probe_deployment(
            store.release_credential(record.id), azure, deployment
        )
    except httpx.HTTPError as error:
        msg = (
            f"The Azure endpoint {azure.endpoint} could not be reached "
            f"({type(error).__name__}), so the deployment could not be checked. "
            "The stored key and mapping are unchanged."
        )
        raise ApiError(msg, status_code=502) from error
    checked_at = datetime.now(tz=UTC).isoformat()
    detail = verdict.model_dump()
    store.record_model_fact(
        record,
        model=model,
        fact={"deployment": deployment, "checked_at": checked_at, **detail},
    )
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.BYOK_DEPLOYMENT_CHECK,
        object_type="provider_connection",
        object_id=connectable.value,
        after={"model": model, "deployment": deployment, "deployed": verdict.deployed},
    )
    return DeploymentCheckResult(
        provider=connectable,
        model=model,
        deployment=deployment,
        deployed=verdict.deployed,
        checked_at=checked_at,
        detail=detail,
    )


def _map_deployment(
    store: ProviderConnectionStore,
    record: ProviderConnectionRecord,
    *,
    model: str,
    deployment: str,
) -> ProviderConnectionRecord:
    """Save one model→deployment mapping onto the stored Azure config.

    Validated through the connection's typed config shape before writing, so
    the row can never hold a mapping the serving side then fails to read.
    """
    if not deployment:
        msg = "deployment must name the Azure deployment this model is served under."
        raise ApiError(msg, status_code=422)
    config = dict(record.config)
    stored = config.get("deployments")
    deployments = dict(stored) if isinstance(stored, dict) else {}
    deployments[model] = deployment
    config["deployments"] = deployments
    try:
        validated = AzureConnectionConfig.model_validate(config)
    except ValidationError as error:
        msg = f"The stored azure_openai connection config is malformed: {error}"
        raise ApiError(msg, status_code=500) from error
    return store.update_config(record.id, validated.model_dump(exclude_none=True))


class SnapshotView(BaseModel):
    """One snapshot as the refresh returns it (never any key material)."""

    model_config = ConfigDict(frozen=True)

    taken_at: str
    source: SnapshotSource
    spend_usd: float | None
    credits_remaining_usd: float | None
    usage_limit_usd: float | None
    detail: JsonObject | None

    @classmethod
    def of(cls, snapshot: ProviderAccountSnapshot) -> SnapshotView:
        """The customer-safe projection of a stored snapshot row."""
        return cls(
            taken_at=snapshot.taken_at,
            source=snapshot.source,
            spend_usd=snapshot.spend_usd,
            credits_remaining_usd=snapshot.credits_remaining_usd,
            usage_limit_usd=snapshot.usage_limit_usd,
            detail=snapshot.detail,
        )


class SpendRefreshResult(BaseModel):
    """The outcome of one spend refresh."""

    model_config = ConfigDict(frozen=True)

    provider: ConnectableProvider
    kind: SpendReportKind
    # False when the staleness floor answered from the stored snapshot (or
    # when there was nothing to query at all).
    refreshed: bool
    staleness_floor_seconds: int
    # When the floor lifts; None once a fresh query is allowed.
    next_refresh_at: str | None
    message: str
    snapshot: SnapshotView | None


@router.post(
    "/orgs/{org_id}/provider-connections/{provider}/spend-refresh",
    response_model=SpendRefreshResult,
)
def refresh_provider_spend(
    org_id: str,
    provider: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> SpendRefreshResult:
    """Read what the provider account reports and store it as a snapshot.

    Refreshes are allowed "quite often": inside a provider's staleness floor
    the latest stored provider read answers instead of a new query, which is
    what makes frequent refresh affordances cheap-safe (Bedrock's Cost
    Explorer bills $0.01 per query, hence its hours-long floor).
    """
    connectable = _connectable(provider)
    _require_manager(client, actor, org_id, provider)
    store = ProviderConnectionStore(client)
    record = store.find(org_id, connectable)
    if record is None:
        msg = f"Provider connection not found: {provider}"
        raise ApiError(msg, status_code=404)
    snapshots = ProviderSnapshotStore(client)
    floor_seconds = SPEND_REFRESH_FLOOR_SECONDS[connectable]

    floored = _floor_answer(snapshots, connectable, record, floor_seconds)
    if floored is not None:
        return floored

    credential, spend_credential = _release_for_spend(store, record)
    try:
        report = read_spend(record, credential=credential, spend_credential=spend_credential)
    except ValidationError as error:
        msg = f"The stored {provider} connection config is malformed: {error}"
        raise ApiError(msg, status_code=500) from error

    snapshot = None
    match report.kind:
        case SpendReportKind.REPORTED:
            if report.source is None:  # pragma: no cover - the adapters always set it
                msg = f"the {provider} spend adapter reported numbers without a source"
                raise ApiError(msg, status_code=500)
            snapshot = snapshots.insert(
                org_id=record.org_id,
                connection_id=record.id,
                provider=connectable,
                source=report.source,
                spend_usd=report.spend_usd,
                credits_remaining_usd=report.credits_remaining_usd,
                usage_limit_usd=report.usage_limit_usd,
                detail=report.detail,
            )
        case SpendReportKind.NOT_REPORTABLE | SpendReportKind.READ_FAILED:
            # Nothing was read, so there is no reading to persist.
            pass
    if snapshot is not None:
        # The floor-answer and nothing-reportable paths persist nothing, so
        # only an actual snapshot write is an auditable mutation.
        record_audit_event(
            client,
            actor=actor,
            org_id=org_id,
            action=AuditAction.BYOK_SPEND_REFRESH,
            object_type="provider_connection",
            object_id=connectable.value,
            after={"provider": connectable.value, "kind": report.kind.value},
        )
    return SpendRefreshResult(
        provider=connectable,
        kind=report.kind,
        refreshed=report.kind is SpendReportKind.REPORTED,
        staleness_floor_seconds=floor_seconds,
        next_refresh_at=None,
        message=report.message,
        snapshot=SnapshotView.of(snapshot) if snapshot is not None else None,
    )


def _floor_answer(
    snapshots: ProviderSnapshotStore,
    connectable: ConnectableProvider,
    record: ProviderConnectionRecord,
    floor_seconds: int,
) -> SpendRefreshResult | None:
    """The stored reading, when the staleness floor forbids a fresh query.

    Never-reportable providers skip the floor: there is no provider call to
    protect and their honest empty state answers immediately.
    """
    if connectable in _NEVER_REPORTABLE_PROVIDERS:
        return None
    latest = snapshots.latest_provider_read(record.id)
    if latest is None:
        return None
    floor_lifts = _taken_at(latest) + timedelta(seconds=floor_seconds)
    if datetime.now(tz=UTC) >= floor_lifts:
        return None
    return SpendRefreshResult(
        provider=connectable,
        kind=SpendReportKind.REPORTED,
        refreshed=False,
        staleness_floor_seconds=floor_seconds,
        next_refresh_at=floor_lifts.isoformat(),
        message=(
            "Showing the stored reading; a fresh provider query "
            f"is allowed after {floor_lifts.isoformat()}."
        ),
        snapshot=SnapshotView.of(latest),
    )


def _release_for_spend(
    store: ProviderConnectionStore, record: ProviderConnectionRecord
) -> tuple[str | None, str | None]:
    """Release exactly the secret this provider's spend read needs.

    Admin-key providers release only the stored admin key (absent → the
    adapter's honest connect-an-admin-key state); never-reportable providers
    release nothing at all.
    """
    if record.provider in _ADMIN_KEY_SPEND_PROVIDERS:
        if record.spend_credential_last4 is None:
            return None, None
        return None, store.release_spend_credential(record.id)
    if record.provider in _NEVER_REPORTABLE_PROVIDERS:
        return None, None
    return store.release_credential(record.id), None


def _connectable(provider: str) -> ConnectableProvider:
    """The path segment as a provider, or the enumerated 400."""
    try:
        return ConnectableProvider(provider)
    except ValueError:
        providers = ", ".join(member.value for member in ConnectableProvider)
        msg = f"provider must be one of: {providers}."
        raise ApiError(msg, status_code=400) from None


def _require_manager(
    client: SupabaseClient, actor: RequestActor, org_id: str, provider: str
) -> None:
    """The management gate shared by all three routes.

    Session users need org-admin (403 below it, the resource 404 for
    non-members). Org API keys get the Contract 3 exception, scoped to
    exactly these management routes: the key IS the org's credential, so a
    key actor manages its OWN org's connections and any other org answers
    the resource 404 — never a 403 that would confirm the org exists.
    ``require_org_role`` keeps refusing key actors admin strength everywhere
    else; the exception deliberately lives here, not in tenancy.
    """
    not_found = f"Provider connection not found: {provider}"
    if actor.api_key_org_id is not None:
        if str(org_id) != actor.api_key_org_id:
            raise ApiError(not_found, status_code=404)
        return
    require_org_role(client, actor, org_id, OrgRole.ADMIN, not_found=not_found)


def _taken_at(snapshot: ProviderAccountSnapshot) -> datetime:
    """A snapshot's timestamp as an aware datetime (fail loud on bad rows)."""
    moment = datetime.fromisoformat(snapshot.taken_at)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment
