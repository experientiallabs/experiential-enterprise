# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The org capability listing the web UI gates enterprise surfaces on.

One route: ``GET /api/orgs/{org_id}/capabilities`` returns every enterprise
capability key mapped to ``available`` or ``unlicensed``. Member-strength:
any member's UI needs to know which entries to render at all (unlicensed
means ABSENT — no nav entry, no upsell chrome). The listing is UX, never the
security boundary: each enterprise route re-checks its own entitlement
server-side via ``require_capability``.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from explabs.api.capabilities import org_capabilities
from explabs.api.routes import get_supabase, load_org_row
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import SupabaseClient

router = APIRouter(prefix="/api", tags=["capabilities"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]


class OrgCapabilitiesResponse(BaseModel):
    """Every enterprise capability key mapped to its licensing state."""

    model_config = ConfigDict(frozen=True)

    capabilities: dict[str, str]


@router.get("/orgs/{org_id}/capabilities")
def get_org_capabilities(
    org_id: str,
    client: Client,
    actor: Actor,
) -> OrgCapabilitiesResponse:
    """Return the org's enterprise capability states (any member)."""
    load_org_row(client, org_id)
    require_org_role(
        client,
        actor,
        org_id,
        OrgRole.USER,
        not_found=f"Organization not found: {org_id}",
    )
    return OrgCapabilitiesResponse(capabilities=org_capabilities(client, org_id))
