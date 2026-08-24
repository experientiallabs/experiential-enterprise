# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Admin management of Experiential Cloud serving lanes (native vLLM on GPUs).

An Experiential Cloud lane is one ``public.model_providers`` row with
``provider = 'experiential_cloud'`` attached to a public catalog model. This
router is the runtime authority operators use to attach, price, re-endpoint,
and turn those lanes ON/OFF from the admin panel and via ``xpladmin_``
superadmin keys, replacing the need to hardcode EC lanes in the catalog seed.

Design invariants (see explabs/gateway/experiential_cloud.py and
explabs/gateway/catalog.py):

* **ON/OFF is the ``status`` column.** ``active`` serves; ``disabled`` stages
  the lane so the catalog builder skips it. A newly attached lane defaults to
  ``disabled`` so it never serves until an operator deliberately flips it ON.
* **The endpoint is per row.** ``base_url`` is honored per deployment, falling
  back to the worker's ``EXPLABS_EXPERIENTIAL_CLOUD_BASE_URL`` when null; a lane
  ON with neither is routable-but-unserving (the builder skips it), which the
  UI warns about.
* **The upstream bearer is a WORKER SECRET, never stored here.** The catalog
  never persists ``EXPLABS_EXPERIENTIAL_CLOUD_API_KEY``; this surface manages
  the endpoint and prices only. There is deliberately no request field, column,
  or response field for the key.
* **EC lanes are platform-funded and public.** Rows are written
  ``billing_source = 'host_managed'`` with ``owning_org_id`` null; the shared
  provider-create path (models_catalog) is reused rather than forked.

Anyone who is not a platform admin gets the standard not-found, exactly like
the other admin routes. Superadmin ``xpladmin_`` keys reach this router with no
route allowlist (see explabs/api/app.py); the Next.js ``/api/admin/*`` session
BFF proxies to it for web callers.
"""

from __future__ import annotations

import os
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response
from postgrest.exceptions import APIError as PostgrestAPIError
from pydantic import BaseModel, ConfigDict, Field, field_validator

from explabs.api.routes import ApiError, get_supabase
from explabs.api.routes.models_catalog import (
    _BASE_URL_MAX_LENGTH,
    _BASE_URL_REGEX,
    DeploymentCreate,
    DeploymentView,
    _create_or_replay_deployment,
    _translated_write_error,
    _utc_now_iso,
)
from explabs.api.tenancy import RequestActor, get_request_actor
from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.gateway.experiential_cloud import (
    BASE_URL_ENV,
)
from explabs.gateway.experiential_cloud import (
    PROVIDER as EXPERIENTIAL_CLOUD_PROVIDER,
)

router = APIRouter(prefix="/api", tags=["experiential-cloud"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]

# Native-vLLM capabilities the launch lanes advertise (mirrors the seed's
# Experiential Cloud rows); set on create so a flipped-ON lane serves streaming
# and structured text without a follow-up edit.
_EXPERIENTIAL_CLOUD_CAPABILITIES: dict[str, bool] = {
    "supports_streaming": True,
    "supports_structured_text": True,
    "supports_stop_sequences": True,
}

# ON serves, OFF stages. A lane is never created ON.
_Status = Literal["active", "disabled"]


def _require_admin(actor: RequestActor) -> None:
    if not actor.is_platform_admin:
        msg = "Not found"
        raise ApiError(msg, status_code=404)


def _require_deployment_uuid(deployment_id: str) -> str:
    """Reject a non-UUID path id as the same 404 a missing lane gets."""
    try:
        uuid.UUID(deployment_id)
    except ValueError as error:
        msg = f"No Experiential Cloud deployment with id {deployment_id!r}"
        raise ApiError(msg, status_code=404) from error
    return deployment_id


def _valid_base_url(value: str | None) -> str | None:
    """Mirror the schema's base_url grammar for a pre-flight 422."""
    if value is not None and _BASE_URL_REGEX.match(value) is None:
        msg = (
            "base_url must be an explicit http(s) endpoint (host, optional "
            "port, optional path; no userinfo, query, or fragment), e.g. "
            "https://your-host:8000/v1"
        )
        raise ValueError(msg)
    return value


# ---------------------------------------------------------------------------
# Request bodies


class ExperientialCloudCreate(BaseModel):
    """Attach an Experiential Cloud lane to a public model (defaults OFF).

    The upstream bearer is a worker secret and is deliberately not a field.
    """

    model_config = ConfigDict(extra="forbid")

    slug: str = Field(min_length=1, max_length=128)
    provider_model_id: str = Field(min_length=1, max_length=256)
    base_url: str | None = Field(default=None, max_length=_BASE_URL_MAX_LENGTH)
    input_micro_usd_per_million: int | None = Field(default=None, ge=0)
    cached_input_micro_usd_per_million: int | None = Field(default=None, ge=0)
    output_micro_usd_per_million: int | None = Field(default=None, ge=0)
    reasoning_micro_usd_per_million: int | None = Field(default=None, ge=0)
    pricing_source: str | None = Field(default=None, max_length=64)
    # Staged OFF by default so a new lane never serves until flipped ON.
    status: _Status = "disabled"

    @field_validator("base_url")
    @classmethod
    def _check_base_url(cls, value: str | None) -> str | None:
        return _valid_base_url(value)


class ExperientialCloudUpdate(BaseModel):
    """Replace one lane's hookup info: endpoint, wire id, and prices.

    A full-resource replacement of the mutable hookup fields; a null price
    clears it (unknown, never zero). The upstream bearer stays a worker secret.
    """

    model_config = ConfigDict(extra="forbid")

    provider_model_id: str = Field(min_length=1, max_length=256)
    base_url: str | None = Field(default=None, max_length=_BASE_URL_MAX_LENGTH)
    input_micro_usd_per_million: int | None = Field(default=None, ge=0)
    cached_input_micro_usd_per_million: int | None = Field(default=None, ge=0)
    output_micro_usd_per_million: int | None = Field(default=None, ge=0)
    reasoning_micro_usd_per_million: int | None = Field(default=None, ge=0)
    pricing_source: str | None = Field(default=None, max_length=64)

    @field_validator("base_url")
    @classmethod
    def _check_base_url(cls, value: str | None) -> str | None:
        return _valid_base_url(value)


class ExperientialCloudStatusBody(BaseModel):
    """Turn a lane ON (``active``) or OFF (``disabled``)."""

    model_config = ConfigDict(extra="forbid")

    status: _Status


# ---------------------------------------------------------------------------
# Views


class ExperientialCloudDeploymentView(BaseModel):
    """One Experiential Cloud lane joined to its public model."""

    model_config = ConfigDict(frozen=True)

    slug: str
    display_name: str
    deployment: DeploymentView

    @classmethod
    def from_rows(
        cls, model: JsonObject, deployment: JsonObject
    ) -> ExperientialCloudDeploymentView:
        """Join a models row and its EC deployment row into one view."""
        return cls(
            slug=str(model["slug"]),
            display_name=str(model["display_name"]),
            deployment=DeploymentView.from_row(deployment),
        )


class ExperientialCloudListView(BaseModel):
    """Envelope for the admin EC lane listing.

    ``worker_base_url_configured`` reflects only THIS control process's
    environment; the gateway worker holds the authoritative origin, so it is an
    advisory hint for the ON-with-no-endpoint warning, not a routing fact.
    """

    deployments: tuple[ExperientialCloudDeploymentView, ...]
    worker_base_url_configured: bool


# ---------------------------------------------------------------------------
# Shared reads


def _resolve_public_model(client: SupabaseClient, slug: str) -> JsonObject:
    """Resolve a slug to its public (``owning_org_id`` null) catalog model.

    Raises:
        ApiError: 404 when no public model carries the slug. EC lanes are
            public and platform-funded, so an org-owned model of the same slug
            is not a valid target.
    """
    result = (
        client.table("models")
        .select("id, slug, display_name")
        .eq("slug", slug)
        .is_("owning_org_id", "null")
        .limit(1)
        .execute()
    )
    if not result.data:
        msg = (
            f"no public catalog model has slug '{slug}'; GET /api/models lists "
            f"the public models an Experiential Cloud lane can attach to"
        )
        raise ApiError(msg, status_code=404)
    return dict(result.data[0])


def _fetch_ec_deployment(client: SupabaseClient, deployment_id: str) -> JsonObject:
    """Load one Experiential Cloud lane row by id.

    Raises:
        ApiError: 404 when the row is absent or not an Experiential Cloud lane.
    """
    result = (
        client.table("model_providers")
        .select("*")
        .eq("id", deployment_id)
        .eq("provider", EXPERIENTIAL_CLOUD_PROVIDER)
        .limit(1)
        .execute()
    )
    if not result.data:
        msg = f"No Experiential Cloud deployment with id {deployment_id!r}"
        raise ApiError(msg, status_code=404)
    return dict(result.data[0])


def _model_by_id(client: SupabaseClient, model_id: object) -> JsonObject:
    """The public model (slug + display_name) behind one EC lane, by id.

    Raises:
        ApiError: 404 when the referenced public model is missing.
    """
    result = (
        client.table("models")
        .select("id, slug, display_name")
        .eq("id", str(model_id))
        .is_("owning_org_id", "null")
        .limit(1)
        .execute()
    )
    if not result.data:
        msg = f"Experiential Cloud deployment references missing public model {model_id!r}"
        raise ApiError(msg, status_code=404)
    return dict(result.data[0])


def _list_view(client: SupabaseClient, deployments: list[JsonObject]) -> ExperientialCloudListView:
    """Join EC lanes to their models and wrap them in the list envelope."""
    model_ids = sorted({str(row["model_id"]) for row in deployments})
    models_by_id: dict[str, JsonObject] = {}
    if model_ids:
        models = (
            client.table("models").select("id, slug, display_name").in_("id", model_ids).execute()
        )
        models_by_id = {str(row["id"]): dict(row) for row in models.data}
    views = tuple(
        ExperientialCloudDeploymentView.from_rows(models_by_id[str(row["model_id"])], row)
        for row in deployments
        if str(row["model_id"]) in models_by_id
    )
    return ExperientialCloudListView(
        deployments=views,
        worker_base_url_configured=bool(os.environ.get(BASE_URL_ENV, "").strip()),
    )


# ---------------------------------------------------------------------------
# Routes


@router.get("/admin/experiential-cloud", response_model=ExperientialCloudListView)
def list_experiential_cloud_deployments(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> ExperientialCloudListView:
    """Every Experiential Cloud lane with its model, endpoint, prices, and state."""
    _require_admin(actor)
    result = (
        client.table("model_providers")
        .select("*")
        .eq("provider", EXPERIENTIAL_CLOUD_PROVIDER)
        .order("created_at")
        .order("id")
        .execute()
    )
    return _list_view(client, [dict(row) for row in result.data])


@router.post(
    "/admin/experiential-cloud",
    response_model=ExperientialCloudDeploymentView,
    status_code=201,
)
def create_experiential_cloud_deployment(
    body: ExperientialCloudCreate,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
    response: Response,
) -> ExperientialCloudDeploymentView:
    """Attach an Experiential Cloud lane to a public model, staged OFF by default.

    Reuses the shared provider-create path (host-funded, idempotent). An exact
    replay converges on the existing row and answers 200; the same identity
    with different attributes answers 409.
    """
    _require_admin(actor)
    model = _resolve_public_model(client, body.slug)
    dep = DeploymentCreate(
        provider=EXPERIENTIAL_CLOUD_PROVIDER,
        provider_model_id=body.provider_model_id,
        base_url=body.base_url,
        input_micro_usd_per_million=body.input_micro_usd_per_million,
        cached_input_micro_usd_per_million=body.cached_input_micro_usd_per_million,
        output_micro_usd_per_million=body.output_micro_usd_per_million,
        reasoning_micro_usd_per_million=body.reasoning_micro_usd_per_million,
        pricing_source=body.pricing_source,
        capabilities=dict(_EXPERIENTIAL_CLOUD_CAPABILITIES),
    )
    row, created = _create_or_replay_deployment(
        client,
        str(model["id"]),
        body.slug,
        None,
        dep,
        billing_source="host_managed",
        status=body.status,
    )
    if not created:
        response.status_code = 200
    return ExperientialCloudDeploymentView.from_rows(model, row)


@router.patch(
    "/admin/experiential-cloud/{deployment_id}",
    response_model=ExperientialCloudDeploymentView,
)
def update_experiential_cloud_deployment(
    deployment_id: str,
    body: ExperientialCloudUpdate,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> ExperientialCloudDeploymentView:
    """Replace one lane's endpoint, wire id, and prices (hookup info only)."""
    _require_admin(actor)
    _require_deployment_uuid(deployment_id)
    _fetch_ec_deployment(client, deployment_id)
    now = _utc_now_iso()
    prices = {
        "input_micro_usd_per_million": body.input_micro_usd_per_million,
        "cached_input_micro_usd_per_million": body.cached_input_micro_usd_per_million,
        "output_micro_usd_per_million": body.output_micro_usd_per_million,
        "reasoning_micro_usd_per_million": body.reasoning_micro_usd_per_million,
    }
    any_price = (
        any(value is not None for value in prices.values()) or body.pricing_source is not None
    )
    payload: JsonObject = {
        "provider_model_id": body.provider_model_id,
        "base_url": body.base_url,
        **prices,
        "pricing_source": body.pricing_source,
        # Stamp the effective time only when this write asserts any price, so a
        # pure endpoint edit does not restart the pricing clock.
        "pricing_effective_at": now if any_price else None,
        "updated_at": now,
    }
    try:
        result = (
            client.table("model_providers")
            .update(payload)
            .eq("id", deployment_id)
            .eq("provider", EXPERIENTIAL_CLOUD_PROVIDER)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _translated_write_error(
            error, action=f"updating Experiential Cloud deployment {deployment_id}"
        ) from error
    row = dict(result.data[0])
    return ExperientialCloudDeploymentView.from_rows(_model_by_id(client, row["model_id"]), row)


@router.post(
    "/admin/experiential-cloud/{deployment_id}/status",
    response_model=ExperientialCloudDeploymentView,
)
def set_experiential_cloud_status(
    deployment_id: str,
    body: ExperientialCloudStatusBody,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> ExperientialCloudDeploymentView:
    """Turn a lane ON (``active``) or OFF (``disabled``).

    Turning ON routes real traffic once an origin resolves; the confirm lives
    in the UI. Naturally idempotent: re-setting the same status is a no-op write.
    """
    _require_admin(actor)
    _require_deployment_uuid(deployment_id)
    _fetch_ec_deployment(client, deployment_id)
    now = _utc_now_iso()
    try:
        result = (
            client.table("model_providers")
            .update({"status": body.status, "updated_at": now})
            .eq("id", deployment_id)
            .eq("provider", EXPERIENTIAL_CLOUD_PROVIDER)
            .execute()
        )
    except PostgrestAPIError as error:
        raise _translated_write_error(
            error, action=f"toggling Experiential Cloud deployment {deployment_id}"
        ) from error
    row = dict(result.data[0])
    return ExperientialCloudDeploymentView.from_rows(_model_by_id(client, row["model_id"]), row)
