# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Typed admin access to the catalog's recommended set (``models.preferred_rank``).

The recommended band is the ordered set of PUBLIC (``owning_org_id`` null)
models carrying a non-null ``preferred_rank``; the storefront and every model
picker star and front-load them. The set is admin-managed: reads come straight
off ``public.models``, and the whole-set replace rides the
``recommended_models_apply`` SECURITY DEFINER function so the clear and the
re-rank land in one transaction (see the migration for why partial orders are
wrong). The seed only provides defaults on a fresh database.
"""

from __future__ import annotations

from postgrest.exceptions import APIError as PostgrestAPIError
from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import JsonObject, SupabaseClient, result_rows

# PostgREST truncates unpaginated selects at its page size; the whole-table
# read below pages past it (same convention as ModelPromotionStore._paged_rows).
_POSTGREST_PAGE_SIZE = 1000


class RecommendedModelUnknownError(LookupError):
    """One or more slugs resolve to no public catalog model."""


class RecommendedModel(BaseModel):
    """One recommended public model, in rank order."""

    model_config = ConfigDict(frozen=True)

    slug: str
    display_name: str
    preferred_rank: int

    def api_view(self) -> JsonObject:
        """The admin projection: exactly the identity triple the panel renders."""
        return {
            "slug": self.slug,
            "display_name": self.display_name,
            "preferred_rank": self.preferred_rank,
        }


class RecommendedModelsStore:
    """Admin reads and the atomic whole-set replace over the recommended band."""

    def __init__(self, client: SupabaseClient) -> None:
        """Wrap a service-role Supabase client (admin writes bypass RLS)."""
        self._client = client

    def list_recommended(self) -> list[RecommendedModel]:
        """Return the public recommended models ascending by rank."""
        ranked = [row for row in self._public_model_rows() if row.get("preferred_rank") is not None]
        ranked.sort(key=lambda row: int(str(row["preferred_rank"])))
        return [RecommendedModel.model_validate(row) for row in ranked]

    def replace(self, slugs: tuple[str, ...]) -> list[RecommendedModel]:
        """Replace the whole recommended set; list order becomes rank 0..N-1.

        One ``recommended_models_apply`` definer call unpins every other
        public model AND assigns the new ranks in a single transaction, then
        returns the resulting band. The function's raise is the single
        unknown-slug authority — no read-then-write pre-check here, so a
        concurrent model delete cannot race a stale existence answer into a
        partial apply. Callers enforce non-empty, non-blank, duplicate-free
        input at the API boundary; the function re-refuses all three.

        Raises:
            RecommendedModelUnknownError: A slug has no public model; the
                message names every missing slug.
        """
        try:
            result = self._client.rpc(
                "recommended_models_apply", {"p_slugs": list(slugs)}
            ).execute()
        except PostgrestAPIError as error:
            if error.code == "P0002":
                raise RecommendedModelUnknownError(error.message) from error
            raise
        return [RecommendedModel.model_validate(row) for row in result_rows(result)]

    def _public_model_rows(self) -> list[JsonObject]:
        """Fetch every public models row, paging past the PostgREST row cap."""
        rows: list[JsonObject] = []
        offset = 0
        while True:
            result = (
                self._client.table("models")
                .select("slug, display_name, preferred_rank")
                .is_("owning_org_id", "null")
                .order("id")
                .range(offset, offset + _POSTGREST_PAGE_SIZE - 1)
                .execute()
            )
            page = list(result_rows(result))
            rows.extend(page)
            if len(page) < _POSTGREST_PAGE_SIZE:
                return rows
            offset += _POSTGREST_PAGE_SIZE
