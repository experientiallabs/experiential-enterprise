# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Typed admin access to ``public.model_promotions`` (v2: scoped promotions).

A promotion is a first-class object: a label, a MODEL scope (explicit
membership rows in ``model_promotion_models``; empty = all models), a LANE
scope (``providers``, matched against the serving attempt's provider; empty =
any), a free per-org allowance (``per_org_cap_micro_usd``), a percent discount,
and a per-org charged-spend ceiling for that discount
(``discount_cap_micro_usd``). Admin CRUD only: writes ride the service role
(the gateway enforces through SECURITY DEFINER functions, the catalog reads the
display projection). Keyed on the promotion ``id``.
"""

from __future__ import annotations

import re

from postgrest.exceptions import APIError as PostgrestAPIError
from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import (
    DeleteCapableQuery,
    JsonObject,
    RepositoryError,
    SupabaseClient,
    first_row,
    result_rows,
)

CAP_SCOPES = ("lifetime", "recurring")

# Which money lane a promotion applies to (mirrors the model_promotions
# funding_scope CHECK). 'platform_funded' is the default and prior behavior:
# gateway_promo_state runs only on the host_managed path, so a promotion has
# always only affected platform-funded charges.
FUNDING_SCOPES = ("all", "platform_funded", "byok")

# Audience org-label keys share the org_labels.key slug shape (mirrored from the
# SQL check ^[a-z][a-z0-9-]{0,31}$ and public.org_label_keys_valid); a bad key
# fails at this typed boundary instead of as a raw 23514.
_LABEL_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,31}$")

# PostgREST truncates unpaginated selects at its page size; every whole-table
# read below pages past it (same convention as the catalog route's _all_rows).
_POSTGREST_PAGE_SIZE = 1000

# The catalog provider vocabulary, mirrored from the SQL check constraints
# (model_promotions_providers_check / model_providers_provider_check) so a bad
# lane scope fails at this typed boundary instead of as a raw 23514. Widen in
# lockstep with those constraints.
PROVIDERS = (
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


class ModelPromotionNotFoundError(LookupError):
    """No promotion exists for the given id."""


class ModelPromotionModelUnknownError(LookupError):
    """One or more slugs resolve to no public catalog model."""


class ModelPromotionScopeError(ValueError):
    """The promotion names neither models nor providers."""


class ModelPromotion(BaseModel):
    """Typed snapshot of one promotion with its resolved model scope."""

    model_config = ConfigDict(frozen=True)

    id: str
    label: str
    model_slugs: tuple[str, ...]
    family_keys: tuple[str, ...]
    providers: tuple[str, ...]
    audience_labels: tuple[str, ...]
    funding_scope: str
    per_org_cap_micro_usd: int
    discount_cap_micro_usd: int
    cap_scope: str
    percent_off: float
    active: bool
    display_order: int

    def api_view(self) -> JsonObject:
        """The admin-panel projection (timestamps stay server-side)."""
        return {
            "id": self.id,
            "label": self.label,
            "model_slugs": list(self.model_slugs),
            "family_keys": list(self.family_keys),
            "providers": list(self.providers),
            "audience_labels": list(self.audience_labels),
            "funding_scope": self.funding_scope,
            "per_org_cap_micro_usd": self.per_org_cap_micro_usd,
            "discount_cap_micro_usd": self.discount_cap_micro_usd,
            "cap_scope": self.cap_scope,
            "percent_off": self.percent_off,
            "active": self.active,
            "display_order": self.display_order,
        }


def _validate_terms(
    *,
    label: str,
    cap_scope: str,
    per_org_cap_micro_usd: int,
    discount_cap_micro_usd: int,
    percent_off: float,
    providers: tuple[str, ...],
    audience_labels: tuple[str, ...],
    funding_scope: str,
    model_slugs: tuple[str, ...],
) -> None:
    """Reject a vocabulary or scope violation before any write."""
    if not label.strip():
        msg = "label must be non-empty"
        raise ValueError(msg)
    if funding_scope not in FUNDING_SCOPES:
        msg = f"unknown funding_scope: {funding_scope!r}"
        raise ValueError(msg)
    bad_audience = tuple(key for key in audience_labels if not _LABEL_KEY_PATTERN.match(key))
    if bad_audience:
        msg = f"invalid audience label keys: {', '.join(bad_audience)}"
        raise ValueError(msg)
    if cap_scope not in CAP_SCOPES:
        msg = f"unknown promotion cap_scope: {cap_scope!r}"
        raise ValueError(msg)
    if per_org_cap_micro_usd < 0:
        msg = "per_org_cap_micro_usd must be non-negative"
        raise ValueError(msg)
    if discount_cap_micro_usd < 0:
        msg = "discount_cap_micro_usd must be non-negative"
        raise ValueError(msg)
    if not 0 <= percent_off <= 100:
        msg = "percent_off must be between 0 and 100"
        raise ValueError(msg)
    unknown = tuple(provider for provider in providers if provider not in PROVIDERS)
    if unknown:
        msg = f"unknown providers: {', '.join(unknown)}"
        raise ValueError(msg)
    if not model_slugs and not providers:
        msg = "a promotion needs a scope: name at least one model or one provider"
        raise ModelPromotionScopeError(msg)


class ModelPromotionStore:
    """Admin reads and writes over promotions and their model scope."""

    def __init__(self, client: SupabaseClient) -> None:
        """Wrap a service-role Supabase client (admin writes bypass RLS)."""
        self._client = client

    def list_all(self) -> list[ModelPromotion]:
        """Return every promotion, ascending by display order then label."""
        # (display_order, label) is a stable total order: label is unique.
        rows = self._paged_rows("model_promotions", "*", ("display_order", "label"))
        memberships = self._memberships(tuple(str(row["id"]) for row in rows))
        return [self._snapshot(row, memberships.get(str(row["id"]), ())) for row in rows]

    def get(self, promotion_id: str) -> ModelPromotion:
        """Return one promotion by id.

        Raises:
            ModelPromotionNotFoundError: No promotion has that id.
        """
        result = self._client.table("model_promotions").select("*").eq("id", promotion_id).execute()
        rows = result_rows(result)
        if not rows:
            raise ModelPromotionNotFoundError(promotion_id)
        memberships = self._memberships((promotion_id,))
        return self._snapshot(rows[0], memberships.get(promotion_id, ()))

    def create(
        self,
        *,
        label: str,
        model_slugs: tuple[str, ...],
        family_keys: tuple[str, ...],
        providers: tuple[str, ...],
        audience_labels: tuple[str, ...] = (),
        funding_scope: str = "platform_funded",
        per_org_cap_micro_usd: int,
        discount_cap_micro_usd: int,
        cap_scope: str,
        percent_off: float,
        active: bool = True,
        display_order: int = 0,
    ) -> ModelPromotion:
        """Create a promotion and its model-scope membership.

        Args:
            label: Operator-facing name; unique across promotions.
            model_slugs: Public catalog slugs the promotion covers; empty means
                every model (the providers list is then the effective scope).
            family_keys: How the admin picked the models (display metadata).
            providers: Serving lanes the promotion applies to; empty = any.
            audience_labels: Org-label keys the org must ALL carry for the
                promotion to apply; empty = every account.
            funding_scope: Money lane the promotion applies to: ``all``,
                ``platform_funded`` (host_managed; the default and prior
                behavior), or ``byok`` (customer_managed).
            per_org_cap_micro_usd: Free-tier allowance in micro-USD (0 = none).
            discount_cap_micro_usd: Per-org charged-spend ceiling for the
                percent discount (0 = the discount never expires).
            cap_scope: ``lifetime`` or ``recurring``.
            percent_off: Credit-spend discount (0-100).
            active: Whether the promotion enforces and displays.
            display_order: Catalog ordering.

        Raises:
            ValueError: On a vocabulary violation (including
                :class:`ModelPromotionScopeError` for an empty scope).
            ModelPromotionModelUnknownError: A slug has no public model.
        """
        _validate_terms(
            label=label,
            cap_scope=cap_scope,
            per_org_cap_micro_usd=per_org_cap_micro_usd,
            discount_cap_micro_usd=discount_cap_micro_usd,
            percent_off=percent_off,
            providers=providers,
            audience_labels=audience_labels,
            funding_scope=funding_scope,
            model_slugs=model_slugs,
        )
        members = self._resolve_public_models(model_slugs)
        promotion_id = self._apply(
            None,
            label=label,
            members=members,
            family_keys=family_keys,
            providers=providers,
            audience_labels=audience_labels,
            funding_scope=funding_scope,
            per_org_cap_micro_usd=per_org_cap_micro_usd,
            discount_cap_micro_usd=discount_cap_micro_usd,
            cap_scope=cap_scope,
            percent_off=percent_off,
            active=active,
            display_order=display_order,
        )
        return self.get(promotion_id)

    def update(
        self,
        promotion_id: str,
        *,
        label: str,
        model_slugs: tuple[str, ...],
        family_keys: tuple[str, ...],
        providers: tuple[str, ...],
        audience_labels: tuple[str, ...],
        funding_scope: str,
        per_org_cap_micro_usd: int,
        discount_cap_micro_usd: int,
        cap_scope: str,
        percent_off: float,
        active: bool,
        display_order: int,
    ) -> ModelPromotion:
        """Replace a promotion's terms and model scope (full resource).

        Raises:
            ValueError: On a vocabulary violation (including
                :class:`ModelPromotionScopeError` for an empty scope).
            ModelPromotionNotFoundError: No promotion has that id.
            ModelPromotionModelUnknownError: A slug has no public model.
        """
        _validate_terms(
            label=label,
            cap_scope=cap_scope,
            per_org_cap_micro_usd=per_org_cap_micro_usd,
            discount_cap_micro_usd=discount_cap_micro_usd,
            percent_off=percent_off,
            providers=providers,
            audience_labels=audience_labels,
            funding_scope=funding_scope,
            model_slugs=model_slugs,
        )
        members = self._resolve_public_models(model_slugs)
        self._apply(
            promotion_id,
            label=label,
            members=members,
            family_keys=family_keys,
            providers=providers,
            audience_labels=audience_labels,
            funding_scope=funding_scope,
            per_org_cap_micro_usd=per_org_cap_micro_usd,
            discount_cap_micro_usd=discount_cap_micro_usd,
            cap_scope=cap_scope,
            percent_off=percent_off,
            active=active,
            display_order=display_order,
        )
        return self.get(promotion_id)

    def delete(self, promotion_id: str) -> None:
        """Remove a promotion (membership rows cascade).

        Raises:
            ModelPromotionNotFoundError: No promotion has that id.
        """
        query = self._client.table("model_promotions")
        if not isinstance(query, DeleteCapableQuery):
            msg = "Supabase query builder does not support delete"
            raise RepositoryError(msg)
        if not result_rows(query.delete().eq("id", promotion_id).execute()):
            raise ModelPromotionNotFoundError(promotion_id)

    def _snapshot(self, row: JsonObject, model_slugs: tuple[str, ...]) -> ModelPromotion:
        """Validate one promotions row plus its membership into the model."""
        return ModelPromotion.model_validate({**row, "model_slugs": tuple(sorted(model_slugs))})

    def _memberships(self, promotion_ids: tuple[str, ...]) -> dict[str, tuple[str, ...]]:
        """Load membership slugs for the given promotions in one paged read."""
        if not promotion_ids:
            return {}
        rows = self._paged_rows(
            "model_promotion_models", "promotion_id, model_id, slug", ("promotion_id", "model_id")
        )
        wanted = set(promotion_ids)
        grouped: dict[str, list[str]] = {}
        for row in rows:
            promotion_id = str(row["promotion_id"])
            if promotion_id in wanted:
                grouped.setdefault(promotion_id, []).append(str(row["slug"]))
        return {key: tuple(sorted(slugs)) for key, slugs in grouped.items()}

    def _apply(
        self,
        promotion_id: str | None,
        *,
        label: str,
        members: tuple[tuple[str, str], ...],
        family_keys: tuple[str, ...],
        providers: tuple[str, ...],
        audience_labels: tuple[str, ...],
        funding_scope: str,
        per_org_cap_micro_usd: int,
        discount_cap_micro_usd: int,
        cap_scope: str,
        percent_off: float,
        active: bool,
        display_order: int,
    ) -> str:
        """Apply the full promotion resource atomically; returns the id.

        One ``model_promotion_apply`` definer call writes the terms row AND
        swaps the membership set in a single transaction. Separate PostgREST
        calls cannot do this, and every partial order is wrong somewhere: new
        terms could land on the old scope, or a half-swapped membership could
        leave the promotion empty (which the gateway reads as "all models"
        through its lanes) or keep a removed model subsidized.
        """
        try:
            result = self._client.rpc(
                "model_promotion_apply",
                {
                    "p_promotion_id": promotion_id,
                    "p_label": label,
                    "p_providers": list(providers),
                    "p_family_keys": list(family_keys),
                    "p_audience_labels": list(audience_labels),
                    "p_funding_scope": funding_scope,
                    "p_per_org_cap_micro_usd": per_org_cap_micro_usd,
                    "p_discount_cap_micro_usd": discount_cap_micro_usd,
                    "p_cap_scope": cap_scope,
                    "p_percent_off": percent_off,
                    "p_active": active,
                    "p_display_order": display_order,
                    "p_members": [
                        {"model_id": model_id, "slug": slug} for slug, model_id in members
                    ],
                },
            ).execute()
        except PostgrestAPIError as error:
            # The RPC's P0002 is the single missing-promotion authority — no
            # read-then-write pre-check, so a concurrent delete cannot race a
            # stale existence answer into a 500.
            if error.code == "P0002":
                raise ModelPromotionNotFoundError(promotion_id) from error
            raise
        row = first_row(result, context=f"model_promotion_apply for {label!r}")
        return str(row["promotion_id"])

    def _paged_rows(self, table: str, columns: str, order: tuple[str, ...]) -> list[JsonObject]:
        """Fetch a whole table past the PostgREST row cap.

        ``order`` must be a stable total order or pages could overlap. Mirrors
        the catalog route's ``_all_rows``; unpaginated selects silently
        truncate at the PostgREST page size, which for these tables would drop
        promotions from the admin list or — worse — shrink a promotion's
        round-tripped model scope on the next full-resource save.
        """
        rows: list[JsonObject] = []
        offset = 0
        while True:
            query = self._client.table(table).select(columns)
            for column in order:
                query = query.order(column)
            result = query.range(offset, offset + _POSTGREST_PAGE_SIZE - 1).execute()
            page = list(result_rows(result))
            rows.extend(page)
            if len(page) < _POSTGREST_PAGE_SIZE:
                return rows
            offset += _POSTGREST_PAGE_SIZE

    def _resolve_public_models(self, model_slugs: tuple[str, ...]) -> tuple[tuple[str, str], ...]:
        """Resolve slugs to public (``owning_org_id`` null) model ids.

        Raises:
            ModelPromotionModelUnknownError: Naming every unresolved slug.
        """
        deduped = tuple(dict.fromkeys(model_slugs))
        if not deduped:
            return ()
        rows = self._paged_rows("models", "id, slug, owning_org_id", ("id",))
        by_slug = {
            str(row["slug"]): str(row["id"]) for row in rows if row.get("owning_org_id") is None
        }
        unknown = tuple(slug for slug in deduped if slug not in by_slug)
        if unknown:
            raise ModelPromotionModelUnknownError(", ".join(unknown))
        return tuple((slug, by_slug[slug]) for slug in deduped)
