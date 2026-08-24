# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The enterprise capability registry: which /ee features an org may use.

Every enterprise capability is OFF by default (docs/enterprise.md §1, the
default-off invariant): a fresh install answers "unlicensed" for all of them,
and unlicensed surfaces render as ABSENT — routes 404, the UI shows nothing.

ENTITLEMENT RESOLUTION — two tiers, matching the common enterprise
open-source split (GitLab .com-plan vs self-managed license, PostHog cloud
vs instance license):

1. PER-ORG GRANTS (hosted multi-tenant): an unexpired ``org_entitlements``
   row grants ONE org one capability. Platform operators enable a paying
   enterprise account; every other org on the same deployment stays
   unlicensed. This is the only tier the hosted platform uses.
2. INSTANCE LICENSE (self-host / enterprise trial, single-tenant): the
   ``EXPLABS_EE_CAPABILITIES`` environment variable (comma-separated keys)
   enables capabilities install-wide — the whole install is one customer.
   This env seam is the placeholder the /ee carve-out's signed license-token
   verifier replaces (public verification key baked into the build, offline
   verification, entitlements + expiry — docs/enterprise.md §1). Swap the
   implementation inside ``org_capabilities``, never the interface.

Neither tier granting a capability means UNLICENSED, and unlicensed
surfaces are ABSENT.

The registry is UX plus route gating, never the security boundary on its own:
each enterprise route re-checks entitlement server-side per request via
``require_capability``.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from enum import StrEnum

from explabs.api.routes import ApiError
from explabs.db.repositories import SupabaseClient, result_rows

_CAPABILITIES_ENV = "EXPLABS_EE_CAPABILITIES"


class EnterpriseCapability(StrEnum):
    """The /ee capability keys.

    PINNED: SSO, SCIM, Teams, and the data-control management routes gate on
    these.
    """

    AUDIT_LOG = "audit_log"
    SSO = "sso"
    SCIM = "scim"
    TEAMS = "teams"
    # Gates MANAGEMENT of provider data-control policies only (E5.3). The
    # gateway worker enforces an existing policy unconditionally — enforcement
    # is never license-dependent.
    DATA_CONTROLS = "data_controls"


def org_capabilities(client: SupabaseClient, org_id: str) -> dict[str, str]:
    """Return every capability key mapped to ``available`` or ``unlicensed``.

    Args:
        client: Service-role Supabase client for the per-org entitlement read.
        org_id: Organization the entitlements are resolved for.

    Returns:
        One entry per ``EnterpriseCapability`` key.
    """
    instance = {
        key.strip() for key in os.environ.get(_CAPABILITIES_ENV, "").split(",") if key.strip()
    }
    granted = _org_entitlements(client, org_id)
    return {
        capability.value: (
            "available"
            if capability.value in instance or capability.value in granted
            else "unlicensed"
        )
        for capability in EnterpriseCapability
    }


def _org_entitlements(client: SupabaseClient, org_id: str) -> frozenset[str]:
    """Return the org's unexpired entitlement capability keys."""
    rows = result_rows(
        client.table("org_entitlements")
        .select("capability, expires_at")
        .eq("org_id", org_id)
        .execute()
    )
    now = datetime.now(tz=UTC)
    keys: set[str] = set()
    for row in rows:
        expires = row.get("expires_at")
        if isinstance(expires, str) and datetime.fromisoformat(expires) <= now:
            continue
        keys.add(str(row.get("capability")))
    return frozenset(keys)


def require_capability(
    client: SupabaseClient, org_id: str, capability: EnterpriseCapability
) -> None:
    """Require that the org is licensed for one enterprise capability.

    Args:
        client: Service-role Supabase client for the per-org entitlement read.
        org_id: Organization owning the target resource.
        capability: The /ee capability the route belongs to.

    Raises:
        ApiError: 404 when unlicensed. Not 403: absent, not forbidden — an
            unlicensed install must not confirm the surface exists, mirroring
            ``require_platform_admin`` in ``explabs/api/tenancy.py``.
    """
    if org_capabilities(client, org_id)[capability.value] != "available":
        msg = "Not found"
        raise ApiError(msg, status_code=404)
