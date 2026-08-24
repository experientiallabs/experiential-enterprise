# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Admin CRUD for scoped promotions (``public.model_promotions`` v2).

Platform-admin surface behind the dashboard admin panel: list promotions,
create one with a label, model scope (explicit slugs; empty = all models),
lane scope (providers; empty = any), free allowance, percent discount, and the
discount's per-org charged-spend ceiling; edit and delete by promotion id. The
gateway enforces these rows at the reservation seam (see
docs/cost-controls.md); this router is the write path. Anyone who is not a
platform admin gets the standard not-found, exactly like the other admin
routes.
"""

from __future__ import annotations

import re
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from explabs.api.routes import ApiError, get_supabase
from explabs.api.tenancy import RequestActor, get_request_actor
from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.db.stores.model_promotion_store import (
    CAP_SCOPES,
    FUNDING_SCOPES,
    PROVIDERS,
    ModelPromotionModelUnknownError,
    ModelPromotionNotFoundError,
    ModelPromotionScopeError,
    ModelPromotionStore,
)

router = APIRouter(prefix="/api", tags=["model-promotions"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]

# Audience org-label keys share the org_labels.key slug shape.
_LABEL_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,31}$")


class ModelPromotionBody(BaseModel):
    """Body of the admin create/update writes (full resource, id in the path)."""

    label: str = Field(min_length=1)
    model_slugs: list[str] = Field(default_factory=list)
    family_keys: list[str] = Field(default_factory=list)
    providers: list[str] = Field(default_factory=list)
    audience_labels: list[str] = Field(default_factory=list)
    funding_scope: str = "platform_funded"
    per_org_cap_micro_usd: int = Field(ge=0)
    discount_cap_micro_usd: int = Field(default=0, ge=0)
    cap_scope: str = "lifetime"
    percent_off: float = Field(default=0, ge=0, le=100)
    active: bool = True
    display_order: int = 0


def _require_admin(actor: RequestActor) -> None:
    if not actor.is_platform_admin:
        msg = "Not found"
        raise ApiError(msg, status_code=404)


def _require_promotion_uuid(promotion_id: str) -> str:
    """Reject a non-UUID path id as the same 404 a missing promotion gets.

    The store filters on the uuid primary key; an unvalidated string would
    surface as a Postgres invalid-uuid error (500) instead of a not-found.
    """
    try:
        uuid.UUID(promotion_id)
    except ValueError as error:
        msg = f"No promotion with id {promotion_id!r}"
        raise ApiError(msg, status_code=404) from error
    return promotion_id


def _validate_vocabulary(body: ModelPromotionBody) -> None:
    """Map vocabulary violations to 400s before touching the store."""
    if body.cap_scope not in CAP_SCOPES:
        msg = f"cap_scope must be one of {', '.join(CAP_SCOPES)}"
        raise ApiError(msg, status_code=400)
    if body.funding_scope not in FUNDING_SCOPES:
        msg = f"funding_scope must be one of {', '.join(FUNDING_SCOPES)}"
        raise ApiError(msg, status_code=400)
    unknown = [provider for provider in body.providers if provider not in PROVIDERS]
    if unknown:
        msg = f"unknown providers: {', '.join(unknown)}"
        raise ApiError(msg, status_code=400)
    bad_audience = [key for key in body.audience_labels if not _LABEL_KEY_PATTERN.match(key)]
    if bad_audience:
        msg = f"invalid audience label keys: {', '.join(bad_audience)}"
        raise ApiError(msg, status_code=400)
    if not body.model_slugs and not body.providers:
        msg = "a promotion needs a scope: name at least one model or one provider"
        raise ApiError(msg, status_code=400)


@router.get("/admin/model-promotions")
def list_model_promotions(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """List every promotion for the admin panel."""
    _require_admin(actor)
    promotions = ModelPromotionStore(client).list_all()
    return {"promotions": [promotion.api_view() for promotion in promotions]}


@router.post("/admin/model-promotions", status_code=201)
def create_model_promotion(
    body: ModelPromotionBody,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Create a scoped promotion."""
    _require_admin(actor)
    _validate_vocabulary(body)
    try:
        promotion = ModelPromotionStore(client).create(
            label=body.label,
            model_slugs=tuple(body.model_slugs),
            family_keys=tuple(body.family_keys),
            providers=tuple(body.providers),
            audience_labels=tuple(body.audience_labels),
            funding_scope=body.funding_scope,
            per_org_cap_micro_usd=body.per_org_cap_micro_usd,
            discount_cap_micro_usd=body.discount_cap_micro_usd,
            cap_scope=body.cap_scope,
            percent_off=body.percent_off,
            active=body.active,
            display_order=body.display_order,
        )
    except ModelPromotionModelUnknownError as error:
        msg = f"No public catalog model has slug(s): {error}"
        raise ApiError(msg, status_code=400) from error
    except ModelPromotionScopeError as error:
        raise ApiError(str(error), status_code=400) from error
    return promotion.api_view()


@router.put("/admin/model-promotions/{promotion_id}")
def update_model_promotion(
    promotion_id: str,
    body: ModelPromotionBody,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Replace an existing promotion's terms and scope (full resource)."""
    _require_admin(actor)
    _require_promotion_uuid(promotion_id)
    _validate_vocabulary(body)
    try:
        promotion = ModelPromotionStore(client).update(
            promotion_id,
            label=body.label,
            model_slugs=tuple(body.model_slugs),
            family_keys=tuple(body.family_keys),
            providers=tuple(body.providers),
            audience_labels=tuple(body.audience_labels),
            funding_scope=body.funding_scope,
            per_org_cap_micro_usd=body.per_org_cap_micro_usd,
            discount_cap_micro_usd=body.discount_cap_micro_usd,
            cap_scope=body.cap_scope,
            percent_off=body.percent_off,
            active=body.active,
            display_order=body.display_order,
        )
    except ModelPromotionNotFoundError as error:
        msg = f"No promotion with id {promotion_id!r}"
        raise ApiError(msg, status_code=404) from error
    except ModelPromotionModelUnknownError as error:
        msg = f"No public catalog model has slug(s): {error}"
        raise ApiError(msg, status_code=400) from error
    except ModelPromotionScopeError as error:
        raise ApiError(str(error), status_code=400) from error
    return promotion.api_view()


@router.delete("/admin/model-promotions/{promotion_id}")
def delete_model_promotion(
    promotion_id: str,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Remove a promotion (its model scope cascades)."""
    _require_admin(actor)
    _require_promotion_uuid(promotion_id)
    try:
        ModelPromotionStore(client).delete(promotion_id)
    except ModelPromotionNotFoundError as error:
        msg = f"No promotion with id {promotion_id!r}"
        raise ApiError(msg, status_code=404) from error
    return {"ok": True}
