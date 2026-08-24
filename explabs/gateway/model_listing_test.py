# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the three-way gateway listing-correctness verifier (core-P19).

The pure classification is proven with synthetic inputs (no network, no
database) so the contract is locked and always green. One opt-in integration
test reconciles the live everything-preview stack read-only and asserts the
listing is honest; it seeds one throwaway org and key (removed on teardown)
purely to read ``GET /v1/models``, and is skipped unless the stack coordinates
are supplied.
"""

from __future__ import annotations

import os

import psycopg
import pytest

from explabs.gateway.conftest import GatewayHarness
from explabs.gateway.model_listing import (
    CatalogModelSummary,
    ListingInputs,
    build_listing_report,
    gather_listing_inputs,
)


def _catalog(*entries: tuple[str, int]) -> tuple[CatalogModelSummary, ...]:
    """Build public active catalog summaries from ``(slug, provider_count)``."""
    return tuple(
        CatalogModelSummary(slug=slug, owning_org_id=None, status="active", provider_count=count)
        for slug, count in entries
    )


def test_fully_consistent_listing_is_ok() -> None:
    """Catalog, gateway, and builder agreeing yields no findings."""
    inputs = ListingInputs(
        catalog=_catalog(("alpha", 1), ("beta", 2)),
        gateway_model_ids=frozenset({"alpha", "beta"}),
        routable_slugs=frozenset({"alpha", "beta"}),
    )
    report = build_listing_report(inputs)
    assert report.ok
    assert report.hard_failures == ()
    assert report.configured_unroutable_in_env == ()
    assert report.catalog_slug_count == 2


def test_listed_without_any_route_is_a_hard_failure() -> None:
    """A public row with zero deployments is listed-but-not-callable."""
    inputs = ListingInputs(
        catalog=_catalog(("alpha", 1), ("orphan", 0)),
        gateway_model_ids=frozenset({"alpha"}),
        routable_slugs=frozenset({"alpha"}),
    )
    report = build_listing_report(inputs)
    assert report.listed_not_callable == ("orphan",)
    assert not report.ok
    assert any("orphan" in line for line in report.hard_failures)


def test_gateway_alias_without_catalog_row_is_a_phantom() -> None:
    """An alias the gateway serves that no public row backs is a hard failure."""
    inputs = ListingInputs(
        catalog=_catalog(("alpha", 1)),
        gateway_model_ids=frozenset({"alpha", "coding"}),
        routable_slugs=frozenset({"alpha"}),
    )
    report = build_listing_report(inputs)
    assert report.phantom_gateway_aliases == ("coding",)
    assert not report.ok


def test_configured_but_unroutable_in_env_is_a_soft_warning() -> None:
    """A configured row the builder cannot route in this env is not a defect."""
    inputs = ListingInputs(
        catalog=_catalog(("alpha", 1), ("needs_key", 1)),
        gateway_model_ids=frozenset({"alpha"}),
        routable_slugs=frozenset({"alpha"}),
    )
    report = build_listing_report(inputs)
    assert report.configured_unroutable_in_env == ("needs_key",)
    assert report.listed_not_callable == ()
    assert report.ok
    assert "needs_key" in report.summary()


def test_routable_slug_absent_from_gateway_is_drift() -> None:
    """The builder resolving a slug the live gateway omits is a hard failure."""
    inputs = ListingInputs(
        catalog=_catalog(("alpha", 1), ("beta", 1)),
        gateway_model_ids=frozenset({"alpha"}),
        routable_slugs=frozenset({"alpha", "beta"}),
    )
    report = build_listing_report(inputs)
    assert report.routable_missing_from_gateway == ("beta",)
    assert not report.ok


def test_hidden_catalog_rows_are_excluded_from_the_listing() -> None:
    """A hidden row is neither listed-not-callable nor expected on the gateway."""
    inputs = ListingInputs(
        catalog=(
            CatalogModelSummary(
                slug="alpha", owning_org_id=None, status="active", provider_count=1
            ),
            CatalogModelSummary(
                slug="retired", owning_org_id=None, status="hidden", provider_count=0
            ),
        ),
        gateway_model_ids=frozenset({"alpha"}),
        routable_slugs=frozenset({"alpha"}),
    )
    report = build_listing_report(inputs)
    assert report.ok
    assert "retired" not in report.listed_not_callable
    assert report.catalog_slug_count == 1


def test_builder_alias_without_catalog_row_is_reported_as_a_warning() -> None:
    """A routable slug missing an active public row surfaces as a note."""
    inputs = ListingInputs(
        catalog=_catalog(("alpha", 1)),
        gateway_model_ids=frozenset({"alpha", "ghost"}),
        routable_slugs=frozenset({"alpha", "ghost"}),
    )
    report = build_listing_report(inputs)
    # ``ghost`` is a phantom on the gateway side and also a builder-vs-catalog
    # warning; both fire so the operator sees the full picture.
    assert report.phantom_gateway_aliases == ("ghost",)
    assert any("ghost" in warning for warning in report.warnings)


# ---------------------------------------------------------------------------
# Live reconciliation against a running stack (opt-in, read-only).


def _live_coordinates() -> dict[str, str]:
    """Collect the stack coordinates or skip the live verifier.

    The verifier reads three surfaces of a running stack: the catalog API
    (``EXPLABS_PERMODEL_API_URL`` + ``EXPLABS_PERMODEL_DEPLOYMENT_KEY``), the
    gateway listing (``EXPLABS_PERMODEL_GATEWAY_URL``), and the platform
    Postgres (``SUPABASE_DB_URL``). All four are required.
    """
    coordinates = {
        "api_url": os.environ.get("EXPLABS_PERMODEL_API_URL", "").strip(),
        "deployment_key": os.environ.get("EXPLABS_PERMODEL_DEPLOYMENT_KEY", "").strip(),
        "gateway_url": os.environ.get("EXPLABS_PERMODEL_GATEWAY_URL", "").strip(),
        "dsn": os.environ.get("SUPABASE_DB_URL", "").strip(),
    }
    missing = [name for name, value in coordinates.items() if not value]
    if missing:
        pytest.skip(
            "live listing verifier needs EXPLABS_PERMODEL_API_URL, "
            "EXPLABS_PERMODEL_DEPLOYMENT_KEY, EXPLABS_PERMODEL_GATEWAY_URL, and "
            f"SUPABASE_DB_URL; missing: {', '.join(missing)}"
        )
    return coordinates


@pytest.mark.integration
def test_live_listing_is_honest() -> None:
    """The live catalog, gateway, and builder must reconcile without defects.

    Seeds one throwaway org and key (removed on teardown) to read the gateway
    listing, reconciles it against the catalog API and the builder, and fails
    with the exact discrepancies if any model is listed-but-not-callable, a
    phantom alias, or routable yet unlisted by the gateway. Environment gaps
    (a configured provider with no credential yet) are reported, not failed.
    """
    coordinates = _live_coordinates()
    harness = GatewayHarness(coordinates["dsn"])
    try:
        org_id = harness.seed_org()
        key = harness.seed_key(org_id)
        with psycopg.connect(coordinates["dsn"], autocommit=True) as connection:
            inputs = gather_listing_inputs(
                api_base_url=coordinates["api_url"],
                deployment_key=coordinates["deployment_key"],
                gateway_url=coordinates["gateway_url"],
                gateway_key=key.raw_key,
                connection=connection,
                environment={},
            )
    finally:
        harness.close()
    report = build_listing_report(inputs)
    print("\n" + report.summary())
    assert report.ok, "listing is dishonest:\n" + "\n".join(report.hard_failures)
