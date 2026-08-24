# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Three-way listing-correctness verifier for the gateway model catalog.

the product owner's launch invariant, verbatim: ``GET /v1/models`` == the catalog ==
actually-callable. A model the storefront lists but that no request can reach,
or an alias the gateway serves that the catalog never advertises, is a broken
promise. This module reconciles the three views of the model surface and
classifies every discrepancy so the listing stays honest:

* the public catalog (``GET /api/models``, the ``models`` table's public rows
  with their ``model_providers`` deployments), the storefront customers read;
* the gateway's served aliases (``GET /v1/models``), what a key can actually
  name in the ``model`` field of a request;
* the per-model routing configuration resolved against a worker environment by
  the shared catalog builder (:func:`explabs.gateway.catalog.build_gateway_catalog`),
  which is the single source of truth for "would this alias be served".

The verifier needs no provider keys: it reads the catalog API, the gateway
listing, and the catalog input tables, and reasons about their set relations.
Classification (see :class:`ListingReport`):

* ``listed_not_callable`` (HARD): a public catalog row with no deployment and
  no waterfall rung at all. It can never be called; the storefront lies.
* ``phantom_gateway_alias`` (HARD): an id the gateway serves that no public
  catalog row backs. The gateway advertises a model the catalog hides.
* ``routable_missing_from_gateway`` (HARD): a public slug the builder resolves
  as routable in this environment that the live gateway nonetheless omits, a
  drift between the built catalog and the served one.
* ``configured_unroutable_in_env`` (SOFT): a public row with a deployment or
  chain that the builder cannot route in THIS environment, almost always a
  provider credential the environment has not been given yet. Not a defect: it
  flips to callable the moment the key lands, which is exactly why the suite is
  green now and tightens as credentials arrive.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field

import httpx
import psycopg

from explabs.gateway.catalog import build_gateway_catalog, load_catalog_rows

# The catalog API caps a page at 1000 rows; the launch catalog is far smaller,
# but paging keeps the reader correct if the catalog ever outgrows one page.
_CATALOG_PAGE_LIMIT = 1000
_DEFAULT_HTTP_TIMEOUT_SECONDS = 15.0


@dataclass(frozen=True, slots=True)
class CatalogModelSummary:
    """One public catalog entry reduced to what listing correctness needs."""

    slug: str
    owning_org_id: str | None
    status: str
    provider_count: int

    @property
    def has_route(self) -> bool:
        """Whether the row carries at least one way to be called."""
        return self.provider_count > 0


@dataclass(frozen=True, slots=True)
class ListingInputs:
    """The three reconciled views, reduced to comparable slug sets.

    ``catalog`` are the PUBLIC catalog entries (``owning_org_id is None``);
    org-private rows never belong on the shared listing and are excluded by the
    gatherers. ``routable_slugs`` is the builder's verdict for the SAME
    environment the live worker runs, so a mismatch with ``gateway_model_ids``
    is real drift rather than an environment difference.
    """

    catalog: tuple[CatalogModelSummary, ...]
    gateway_model_ids: frozenset[str]
    routable_slugs: frozenset[str]

    @property
    def catalog_slugs(self) -> frozenset[str]:
        """Every active public catalog slug."""
        return frozenset(entry.slug for entry in self.catalog if entry.status == "active")

    @property
    def catalog_slugs_with_route(self) -> frozenset[str]:
        """Active public slugs carrying at least one deployment or chain."""
        return frozenset(
            entry.slug for entry in self.catalog if entry.status == "active" and entry.has_route
        )


@dataclass(frozen=True, slots=True)
class ListingReport:
    """The reconciliation outcome: hard defects, soft gaps, and a summary."""

    listed_not_callable: tuple[str, ...]
    phantom_gateway_aliases: tuple[str, ...]
    routable_missing_from_gateway: tuple[str, ...]
    configured_unroutable_in_env: tuple[str, ...]
    catalog_slug_count: int
    gateway_alias_count: int
    routable_slug_count: int
    warnings: tuple[str, ...] = field(default_factory=tuple)

    @property
    def hard_failures(self) -> tuple[str, ...]:
        """Every finding that makes the listing dishonest, one line each."""
        lines: list[str] = []
        lines.extend(
            f"listed-but-not-callable: {slug} is a public catalog row with no "
            "deployment or waterfall rung"
            for slug in self.listed_not_callable
        )
        lines.extend(
            f"phantom-gateway-alias: {alias} is served by GET /v1/models but no "
            "public catalog row lists it"
            for alias in self.phantom_gateway_aliases
        )
        lines.extend(
            f"routable-but-unlisted-by-gateway: {slug} is routable in this "
            "environment yet absent from GET /v1/models"
            for slug in self.routable_missing_from_gateway
        )
        return tuple(lines)

    @property
    def ok(self) -> bool:
        """Whether the listing is honest (no hard failures)."""
        return not self.hard_failures

    def summary(self) -> str:
        """Render a human-readable multi-line report of every finding."""
        lines = [
            "Gateway listing verifier (core-P19)",
            f"  catalog public slugs : {self.catalog_slug_count}",
            f"  gateway aliases      : {self.gateway_alias_count}",
            f"  routable in env      : {self.routable_slug_count}",
            f"  status               : {'OK' if self.ok else 'FAIL'}",
        ]
        lines.extend(f"  FAIL  {line}" for line in self.hard_failures)
        lines.extend(
            f"  WARN  configured-unroutable-in-env: {slug} has a deployment or "
            "chain but no routable credential in this environment (flips to "
            "callable once the provider key is configured)"
            for slug in self.configured_unroutable_in_env
        )
        lines.extend(f"  note  {warning}" for warning in self.warnings)
        return "\n".join(lines)


def build_listing_report(inputs: ListingInputs) -> ListingReport:
    """Reconcile the three views into a classified :class:`ListingReport`.

    Pure and deterministic: the same inputs always yield the same report, so
    the classification is unit-tested without any network or database.

    Args:
        inputs: The three reconciled views (catalog, gateway, builder verdict).

    Returns:
        The classified reconciliation outcome.
    """
    catalog_slugs = inputs.catalog_slugs
    with_route = inputs.catalog_slugs_with_route

    listed_not_callable = tuple(sorted(catalog_slugs - with_route))
    phantom = tuple(sorted(inputs.gateway_model_ids - catalog_slugs))
    routable_missing = tuple(sorted(inputs.routable_slugs - inputs.gateway_model_ids))
    # A configured row the builder could not route in this environment: it has
    # a deployment/chain (with_route) but the builder produced no alias for it.
    configured_unroutable = tuple(sorted(with_route - inputs.routable_slugs))

    warnings: list[str] = []
    routable_not_in_catalog = inputs.routable_slugs - catalog_slugs
    if routable_not_in_catalog:
        warnings.append(
            "builder resolved aliases with no active public catalog row: "
            + ", ".join(sorted(routable_not_in_catalog))
        )

    return ListingReport(
        listed_not_callable=listed_not_callable,
        phantom_gateway_aliases=phantom,
        routable_missing_from_gateway=routable_missing,
        configured_unroutable_in_env=configured_unroutable,
        catalog_slug_count=len(catalog_slugs),
        gateway_alias_count=len(inputs.gateway_model_ids),
        routable_slug_count=len(inputs.routable_slugs),
        warnings=tuple(warnings),
    )


# ---------------------------------------------------------------------------
# Live gatherers: read the three views off a running stack (read-only).


def fetch_catalog_models(
    *,
    base_url: str,
    deployment_key: str,
    actor_id: str | None = None,
    timeout_seconds: float = _DEFAULT_HTTP_TIMEOUT_SECONDS,
) -> tuple[CatalogModelSummary, ...]:
    """Read the public catalog via ``GET /api/models``, paged, read-only.

    Args:
        base_url: Control/all API origin (the api pod, e.g. ``http://host:18460``).
        deployment_key: The web deployment credential the catalog reads accept.
        actor_id: Optional actor header; omitted keeps the response to the
            public catalog, which is the surface the verifier reconciles.
        timeout_seconds: Per-request timeout.

    Returns:
        One summary per PUBLIC catalog entry (org-private rows excluded).
    """
    headers = {"Authorization": f"Bearer {deployment_key}"}
    if actor_id is not None:
        headers["X-Explabs-Actor-Id"] = actor_id
    summaries: list[CatalogModelSummary] = []
    offset = 0
    root = base_url.rstrip("/")
    with httpx.Client(timeout=timeout_seconds) as client:
        while True:
            response = client.get(
                f"{root}/api/models",
                params={"limit": _CATALOG_PAGE_LIMIT, "offset": offset},
                headers=headers,
            )
            response.raise_for_status()
            payload = response.json()
            entries = payload.get("models", [])
            for entry in entries:
                model = entry["model"]
                if model.get("owning_org_id") is not None:
                    continue
                summaries.append(
                    CatalogModelSummary(
                        slug=str(model["slug"]),
                        owning_org_id=None,
                        status=str(model["status"]),
                        provider_count=len(entry.get("providers", [])),
                    )
                )
            offset += len(entries)
            if not entries or offset >= int(payload.get("total", offset)):
                break
    return tuple(summaries)


def fetch_gateway_model_ids(
    *,
    gateway_url: str,
    gateway_key: str,
    timeout_seconds: float = _DEFAULT_HTTP_TIMEOUT_SECONDS,
) -> frozenset[str]:
    """Read the served aliases via ``GET /v1/models`` with a gateway key.

    Args:
        gateway_url: Gateway origin (worker or edge, e.g. ``http://host:18461``).
        gateway_key: A valid gateway Bearer key (``xpl_``); the listing is the
            same public alias set for any org, plus that org's own aliases.
        timeout_seconds: Per-request timeout.

    Returns:
        The set of model ids the gateway advertises.
    """
    with httpx.Client(timeout=timeout_seconds) as client:
        response = client.get(
            f"{gateway_url.rstrip('/')}/v1/models",
            headers={"Authorization": f"Bearer {gateway_key}"},
        )
        response.raise_for_status()
        payload = response.json()
    return frozenset(str(entry["id"]) for entry in payload.get("data", []))


def resolve_routable_slugs(
    *,
    connection: psycopg.Connection[tuple[object, ...]],
    environment: Mapping[str, str],
) -> frozenset[str]:
    """Build the catalog off the DB and return the routable PUBLIC slugs.

    This is the same builder the worker runs, so the result is exactly the
    public alias set the gateway would serve for the given environment.

    Args:
        connection: Direct read connection to the platform Postgres.
        environment: Worker environment consulted only for credential presence.

    Returns:
        The public (org-unscoped) slugs the builder resolves as routable.
    """
    rows = load_catalog_rows(connection)
    build = build_gateway_catalog(rows, environment=environment)
    return frozenset(plan.alias_name for plan in build.alias_plans if plan.org_id is None)


def gather_listing_inputs(
    *,
    api_base_url: str,
    deployment_key: str,
    gateway_url: str,
    gateway_key: str,
    connection: psycopg.Connection[tuple[object, ...]],
    environment: Mapping[str, str],
) -> ListingInputs:
    """Gather all three views off a running stack into one :class:`ListingInputs`.

    Args:
        api_base_url: Control/all API origin for the catalog read.
        deployment_key: Web deployment credential for the catalog read.
        gateway_url: Gateway origin for ``GET /v1/models``.
        gateway_key: Valid gateway Bearer key for ``GET /v1/models``.
        connection: Read connection to the platform Postgres for the builder.
        environment: Worker environment for the builder's credential presence
            checks (pass the live worker's environment to match its verdict).

    Returns:
        The reconciled three-view inputs.
    """
    return ListingInputs(
        catalog=fetch_catalog_models(base_url=api_base_url, deployment_key=deployment_key),
        gateway_model_ids=fetch_gateway_model_ids(gateway_url=gateway_url, gateway_key=gateway_key),
        routable_slugs=resolve_routable_slugs(connection=connection, environment=environment),
    )


def merge_warnings(report: ListingReport, extra: Iterable[str]) -> ListingReport:
    """Return a copy of ``report`` with additional advisory warnings appended.

    Args:
        report: The report to extend.
        extra: Advisory lines to append (deployment-specific context).

    Returns:
        A new report carrying the combined warnings.
    """
    combined: Sequence[str] = (*report.warnings, *extra)
    return ListingReport(
        listed_not_callable=report.listed_not_callable,
        phantom_gateway_aliases=report.phantom_gateway_aliases,
        routable_missing_from_gateway=report.routable_missing_from_gateway,
        configured_unroutable_in_env=report.configured_unroutable_in_env,
        catalog_slug_count=report.catalog_slug_count,
        gateway_alias_count=report.gateway_alias_count,
        routable_slug_count=report.routable_slug_count,
        warnings=tuple(combined),
    )
