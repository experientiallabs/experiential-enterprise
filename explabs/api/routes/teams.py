# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Org team management (design E4 item 1, gated on the TEAMS /ee capability).

Teams are first-class org objects: named groups of org members, with API keys
attributed to a team through ``api_keys.team_id``. This surface is
attribution-only in this wave — team-scoped budgets and per-team usage
rollups land after PR #563 merges — so key assignment writes ``team_id``
directly on ``api_keys`` and never touches limits, budgets, or the gateway
hot path.

Reads are member-strength; every mutation is admin-strength, capability-gated
per request (default-off: an unlicensed org 404s exactly like the surface
does not exist), and emits one audit event.
"""

from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.capabilities import EnterpriseCapability, require_capability
from explabs.api.routes import ApiError, get_supabase, load_org_row
from explabs.api.tenancy import OrgRole, RequestActor, get_request_actor, require_org_role
from explabs.db.repositories import (
    DeleteCapableQuery,
    JsonObject,
    RepositoryError,
    SupabaseClient,
    SupabaseQueryBuilder,
    find_one_by_columns,
    result_rows,
)

router = APIRouter(prefix="/api", tags=["teams"])

Actor = Annotated[RequestActor, Depends(get_request_actor)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]


class TeamNameBody(BaseModel):
    """Create/rename payload: the team's display name."""

    name: str = Field(min_length=1, max_length=120)


class TeamView(BaseModel):
    """One team as the settings panel reads it."""

    model_config = ConfigDict(frozen=True)

    team_id: str
    org_id: str
    name: str
    created_by: str | None
    created_at: str
    updated_at: str
    member_count: int
    key_count: int
    # Active keys attributed to the team; the settings panel joins these ids
    # against its org key listing to render and unassign without a second
    # backend surface. Always len == key_count.
    assigned_key_ids: list[str]


class TeamListResponse(BaseModel):
    """Every team in one organization, with membership and key attribution."""

    org_id: str
    teams: list[TeamView]


class TeamMemberView(BaseModel):
    """One team roster row."""

    model_config = ConfigDict(frozen=True)

    team_id: str
    user_id: str
    added_by: str | None
    created_at: str


class TeamKeyAssignmentView(BaseModel):
    """One API key's team attribution after an assign/unassign."""

    model_config = ConfigDict(frozen=True)

    api_key_id: str
    team_id: str | None


class DeleteTeamResponse(BaseModel):
    """Outcome of a team deletion, naming how many keys were detached."""

    team_id: str
    deleted: bool
    unassigned_key_count: int


def _delete_query(client: SupabaseClient, table: str) -> SupabaseQueryBuilder:
    """Start a delete on one table, probing the narrow delete capability."""
    query = client.table(table)
    if not isinstance(query, DeleteCapableQuery):
        msg = "Supabase query builder does not support delete"
        raise RepositoryError(msg)
    return query.delete()


def _org_not_found(org_id: str) -> str:
    return f"Organization not found: {org_id}"


def _now() -> str:
    """Timestamp for writes; explicit so the row is complete at insert time."""
    return datetime.now(tz=UTC).isoformat()


def _require_teams_surface(
    client: SupabaseClient,
    actor: RequestActor,
    org_id: str,
    minimum: OrgRole,
) -> None:
    """Gate one teams handler: org exists, role suffices, TEAMS is licensed.

    Role before capability (the audit_log.py convention): membership and role
    semantics are unchanged — outsiders get the org 404, under-role members
    get 403 — and only licensing produces the extra "Not found" 404.
    """
    load_org_row(client, org_id)
    require_org_role(client, actor, org_id, minimum, not_found=_org_not_found(org_id))
    require_capability(client, org_id, EnterpriseCapability.TEAMS)


def _load_team(client: SupabaseClient, org_id: str, team_id: str) -> JsonObject:
    """Fetch a team scoped to its org, or fail with the resource 404."""
    row = find_one_by_columns(client, "organization_teams", {"team_id": team_id, "org_id": org_id})
    if row is None:
        msg = f"Team not found: {team_id}"
        raise ApiError(msg, status_code=404)
    return row


def _org_team_keys(client: SupabaseClient, org_id: str) -> tuple[JsonObject, ...]:
    """The org's key rows that carry a team attribution."""
    rows = result_rows(
        client.table("api_keys").select("id, team_id, revoked_at").eq("org_id", org_id).execute()
    )
    return tuple(row for row in rows if row.get("team_id") is not None)


def _team_view(
    row: JsonObject,
    *,
    member_count: int,
    assigned_key_ids: list[str],
) -> TeamView:
    """Project one ``organization_teams`` row onto the wire shape."""
    created_by = row.get("created_by")
    return TeamView(
        team_id=str(row["team_id"]),
        org_id=str(row["org_id"]),
        name=str(row["name"]),
        created_by=str(created_by) if created_by is not None else None,
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
        member_count=member_count,
        key_count=len(assigned_key_ids),
        assigned_key_ids=assigned_key_ids,
    )


def _counted_view(client: SupabaseClient, row: JsonObject) -> TeamView:
    """A team view with its live member and active-key counts."""
    team_id = str(row["team_id"])
    members = result_rows(
        client.table("organization_team_members").select("user_id").eq("team_id", team_id).execute()
    )
    key_ids = [
        str(key["id"])
        for key in _org_team_keys(client, str(row["org_id"]))
        if str(key["team_id"]) == team_id and key.get("revoked_at") is None
    ]
    return _team_view(row, member_count=len(members), assigned_key_ids=key_ids)


def _clean_name(body: TeamNameBody) -> str:
    """The trimmed team name; whitespace-only names fail at the boundary."""
    name = body.name.strip()
    if not name:
        msg = "Team name must not be blank"
        raise ApiError(msg, status_code=422)
    return name


def _require_name_free(client: SupabaseClient, org_id: str, name: str, *, except_team: str) -> None:
    """Refuse a name another team in the org already holds."""
    existing = find_one_by_columns(client, "organization_teams", {"org_id": org_id, "name": name})
    if existing is not None and str(existing["team_id"]) != except_team:
        msg = f"A team named {name!r} already exists in this organization"
        raise ApiError(msg, status_code=409)


@router.get("/orgs/{org_id}/teams")
def list_teams(org_id: str, client: Client, actor: Actor) -> TeamListResponse:
    """List the org's teams with member counts and active-key counts."""
    _require_teams_surface(client, actor, org_id, OrgRole.USER)
    team_rows = result_rows(
        client.table("organization_teams").select("*").eq("org_id", org_id).order("name").execute()
    )
    team_ids = [str(row["team_id"]) for row in team_rows]
    member_rows = (
        result_rows(
            client.table("organization_team_members")
            .select("team_id")
            .in_("team_id", team_ids)
            .execute()
        )
        if team_ids
        else ()
    )
    member_counts = Counter(str(row["team_id"]) for row in member_rows)
    team_key_ids: dict[str, list[str]] = {team_id: [] for team_id in team_ids}
    for key in _org_team_keys(client, org_id):
        if key.get("revoked_at") is None and str(key["team_id"]) in team_key_ids:
            team_key_ids[str(key["team_id"])].append(str(key["id"]))
    return TeamListResponse(
        org_id=org_id,
        teams=[
            _team_view(
                row,
                member_count=member_counts[str(row["team_id"])],
                assigned_key_ids=team_key_ids[str(row["team_id"])],
            )
            for row in team_rows
        ],
    )


@router.post("/orgs/{org_id}/teams")
def create_team(org_id: str, body: TeamNameBody, client: Client, actor: Actor) -> TeamView:
    """Create one named team (admins only)."""
    _require_teams_surface(client, actor, org_id, OrgRole.ADMIN)
    name = _clean_name(body)
    _require_name_free(client, org_id, name, except_team="")
    now = _now()
    row: JsonObject = {
        "team_id": str(uuid4()),
        "org_id": org_id,
        "name": name,
        "created_by": actor.user_id,
        "created_at": now,
        "updated_at": now,
    }
    client.table("organization_teams").insert(dict(row)).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.TEAMS_CREATE,
        object_type="team",
        object_id=str(row["team_id"]),
        after={"name": name},
    )
    return _team_view(row, member_count=0, assigned_key_ids=[])


@router.patch("/orgs/{org_id}/teams/{team_id}")
def rename_team(
    org_id: str,
    team_id: str,
    body: TeamNameBody,
    client: Client,
    actor: Actor,
) -> TeamView:
    """Rename one team (admins only)."""
    _require_teams_surface(client, actor, org_id, OrgRole.ADMIN)
    team = _load_team(client, org_id, team_id)
    name = _clean_name(body)
    _require_name_free(client, org_id, name, except_team=team_id)
    previous = str(team["name"])
    updated = dict(team) | {"name": name, "updated_at": _now()}
    client.table("organization_teams").update(
        {"name": name, "updated_at": str(updated["updated_at"])}
    ).eq("team_id", team_id).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.TEAMS_RENAME,
        object_type="team",
        object_id=team_id,
        before={"name": previous},
        after={"name": name},
    )
    return _counted_view(client, updated)


@router.delete("/orgs/{org_id}/teams/{team_id}")
def delete_team(
    org_id: str,
    team_id: str,
    client: Client,
    actor: Actor,
    *,
    force: bool = False,
) -> DeleteTeamResponse:
    """Delete one team (admins only).

    Refused while active API keys are still assigned, unless ``force=true``,
    which detaches every assigned key (``api_keys.team_id`` goes null) and
    reports how many. The explicit detach mirrors the FK's ``on delete set
    null`` so the API's behavior is the schema's behavior, stated once.
    """
    _require_teams_surface(client, actor, org_id, OrgRole.ADMIN)
    team = _load_team(client, org_id, team_id)
    assigned = [key for key in _org_team_keys(client, org_id) if str(key["team_id"]) == team_id]
    active = [key for key in assigned if key.get("revoked_at") is None]
    if active and not force:
        msg = (
            f"Team has {len(active)} assigned API keys; "
            "pass force=true to unassign them and delete the team"
        )
        raise ApiError(msg, status_code=409)
    if assigned:
        client.table("api_keys").update({"team_id": None}).eq("team_id", team_id).execute()
    client.table("gateway_identities").update({"team_id": None}).eq("team_id", team_id).execute()
    _delete_query(client, "organization_team_members").eq("team_id", team_id).execute()
    _delete_query(client, "organization_teams").eq("team_id", team_id).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.TEAMS_DELETE,
        object_type="team",
        object_id=team_id,
        before={"name": str(team["name"])},
        context={"unassigned_key_count": len(assigned)},
    )
    return DeleteTeamResponse(team_id=team_id, deleted=True, unassigned_key_count=len(assigned))


@router.get("/orgs/{org_id}/teams/{team_id}/members")
def list_team_members(
    org_id: str,
    team_id: str,
    client: Client,
    actor: Actor,
) -> dict[str, list[TeamMemberView]]:
    """List one team's roster, oldest membership first."""
    _require_teams_surface(client, actor, org_id, OrgRole.USER)
    _load_team(client, org_id, team_id)
    rows = result_rows(
        client.table("organization_team_members")
        .select("*")
        .eq("team_id", team_id)
        .order("created_at")
        .execute()
    )
    return {"members": [_member_view(row) for row in rows]}


@router.put("/orgs/{org_id}/teams/{team_id}/members/{user_id}")
def add_team_member(
    org_id: str,
    team_id: str,
    user_id: str,
    client: Client,
    actor: Actor,
) -> TeamMemberView:
    """Add one org member to a team (admins only); idempotent."""
    _require_teams_surface(client, actor, org_id, OrgRole.ADMIN)
    _load_team(client, org_id, team_id)
    org_member = find_one_by_columns(
        client, "organization_members", {"org_id": org_id, "user_id": user_id}
    )
    if org_member is None:
        # The DB trigger enforces the same invariant; failing here keeps the
        # error typed instead of surfacing as a Postgres 23514.
        msg = f"Organization member not found: {user_id}"
        raise ApiError(msg, status_code=404)
    existing = find_one_by_columns(
        client, "organization_team_members", {"team_id": team_id, "user_id": user_id}
    )
    if existing is not None:
        return _member_view(existing)
    row: JsonObject = {
        "team_id": team_id,
        "user_id": user_id,
        "added_by": actor.user_id,
        "created_at": _now(),
    }
    client.table("organization_team_members").insert(dict(row)).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.TEAMS_MEMBER_ADD,
        object_type="team",
        object_id=team_id,
        after={"user_id": user_id},
    )
    return _member_view(row)


@router.delete("/orgs/{org_id}/teams/{team_id}/members/{user_id}")
def remove_team_member(
    org_id: str,
    team_id: str,
    user_id: str,
    client: Client,
    actor: Actor,
) -> dict[str, bool]:
    """Remove one member from a team (admins only)."""
    _require_teams_surface(client, actor, org_id, OrgRole.ADMIN)
    _load_team(client, org_id, team_id)
    membership = find_one_by_columns(
        client, "organization_team_members", {"team_id": team_id, "user_id": user_id}
    )
    if membership is None:
        msg = f"Team member not found: {user_id}"
        raise ApiError(msg, status_code=404)
    _delete_query(client, "organization_team_members").eq("team_id", team_id).eq(
        "user_id", user_id
    ).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.TEAMS_MEMBER_REMOVE,
        object_type="team",
        object_id=team_id,
        before={"user_id": user_id},
    )
    return {"removed": True}


@router.put("/orgs/{org_id}/teams/{team_id}/keys/{api_key_id}")
def assign_team_key(
    org_id: str,
    team_id: str,
    api_key_id: str,
    client: Client,
    actor: Actor,
) -> TeamKeyAssignmentView:
    """Attribute one of the org's API keys to a team (admins only)."""
    _require_teams_surface(client, actor, org_id, OrgRole.ADMIN)
    _load_team(client, org_id, team_id)
    key = find_one_by_columns(client, "api_keys", {"id": api_key_id, "org_id": org_id})
    if key is None:
        msg = f"API key not found: {api_key_id}"
        raise ApiError(msg, status_code=404)
    previous = key.get("team_id")
    client.table("api_keys").update({"team_id": team_id}).eq("id", api_key_id).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.TEAMS_KEY_ASSIGN,
        object_type="api_key",
        object_id=api_key_id,
        before={"team_id": str(previous) if previous is not None else None},
        after={"team_id": team_id},
    )
    return TeamKeyAssignmentView(api_key_id=api_key_id, team_id=team_id)


@router.delete("/orgs/{org_id}/teams/{team_id}/keys/{api_key_id}")
def unassign_team_key(
    org_id: str,
    team_id: str,
    api_key_id: str,
    client: Client,
    actor: Actor,
) -> TeamKeyAssignmentView:
    """Clear one API key's attribution to this team (admins only)."""
    _require_teams_surface(client, actor, org_id, OrgRole.ADMIN)
    _load_team(client, org_id, team_id)
    key = find_one_by_columns(client, "api_keys", {"id": api_key_id, "org_id": org_id})
    if key is None or str(key.get("team_id")) != team_id:
        msg = f"API key is not assigned to this team: {api_key_id}"
        raise ApiError(msg, status_code=404)
    client.table("api_keys").update({"team_id": None}).eq("id", api_key_id).execute()
    record_audit_event(
        client,
        actor=actor,
        org_id=org_id,
        action=AuditAction.TEAMS_KEY_ASSIGN,
        object_type="api_key",
        object_id=api_key_id,
        before={"team_id": team_id},
        after={"team_id": None},
    )
    return TeamKeyAssignmentView(api_key_id=api_key_id, team_id=None)


def _member_view(row: JsonObject) -> TeamMemberView:
    """Project one ``organization_team_members`` row onto the wire shape."""
    added_by = row.get("added_by")
    return TeamMemberView(
        team_id=str(row["team_id"]),
        user_id=str(row["user_id"]),
        added_by=str(added_by) if added_by is not None else None,
        created_at=str(row["created_at"]),
    )
