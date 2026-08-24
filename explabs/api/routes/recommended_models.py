# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Admin read/replace for the catalog's recommended set (``models.preferred_rank``).

Platform-admin surface behind the dashboard admin panel and the ``xpladmin_``
superadmin keys: GET returns the current band in rank order, PUT replaces the
whole ordered set (list order becomes rank 0..N-1 on exactly the named public
models; every other public model is unpinned atomically). The seed only
provides defaults on a fresh database, so this router is the runtime authority
over what the storefront and model pickers star. Anyone who is not a platform
admin gets the standard not-found, exactly like the other admin routes.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from explabs.api.routes import ApiError, get_supabase
from explabs.api.tenancy import RequestActor, get_request_actor
from explabs.db.repositories import JsonObject, SupabaseClient
from explabs.db.stores.recommended_models_store import (
    RecommendedModelsStore,
    RecommendedModelUnknownError,
)

router = APIRouter(prefix="/api", tags=["recommended-models"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]


class RecommendedModelsBody(BaseModel):
    """Body of the admin replace: the full recommended list, in rank order.

    Non-empty by contract: an all-unpinned catalog is indistinguishable from a
    never-seeded one, so a re-seed would silently restore the defaults over an
    admin's "empty" choice (and the storefront assumes a recommended band).
    """

    slugs: list[str] = Field(min_length=1)


def _require_admin(actor: RequestActor) -> None:
    if not actor.is_platform_admin:
        msg = "Not found"
        raise ApiError(msg, status_code=404)


def _validate_slugs(slugs: list[str]) -> None:
    """Refuse blank and duplicate slugs before touching the store.

    List order defines the rank, so a repeated slug has no deterministic
    position; the SQL function re-refuses both, but at this boundary the
    violation gets a 400 naming the offenders instead of a 500.
    """
    if any(not slug.strip() for slug in slugs):
        msg = "slugs must be non-empty catalog model slugs"
        raise ApiError(msg, status_code=400)
    duplicates = sorted({slug for slug in slugs if slugs.count(slug) > 1})
    if duplicates:
        msg = (
            f"duplicate slugs: {', '.join(duplicates)}"
            " (list order defines the rank, so each slug appears once)"
        )
        raise ApiError(msg, status_code=400)


@router.get("/admin/recommended-models")
def list_recommended_models(
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """The current recommended set in rank order, for the panel and scripts."""
    _require_admin(actor)
    models = RecommendedModelsStore(client).list_recommended()
    return {"models": [model.api_view() for model in models]}


@router.put("/admin/recommended-models")
def replace_recommended_models(
    body: RecommendedModelsBody,
    client: Annotated[SupabaseClient, Depends(get_supabase)],
    actor: Actor,
) -> JsonObject:
    """Replace the whole recommended set; list order becomes rank 0..N-1."""
    _require_admin(actor)
    _validate_slugs(body.slugs)
    try:
        models = RecommendedModelsStore(client).replace(tuple(body.slugs))
    except RecommendedModelUnknownError as error:
        raise ApiError(str(error), status_code=400) from error
    return {"models": [model.api_view() for model in models]}
