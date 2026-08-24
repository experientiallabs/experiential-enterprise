# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""SCIM 2.0 provisioning server (design E3, the /ee protocol surface).

Mounted at ``/scim/v2`` and authenticated by the per-org SCIM bearer token
(hash lookup in ``org_scim_tokens`` -> org binding), never the deployment
key: an IdP holds exactly one org's credential and can only ever act inside
that org's blast radius. Every handler then re-checks the SCIM enterprise
capability server-side (default-off; unlicensed answers 404).

INTEGRATION NOTE (the app-level auth seam). ``explabs/api/app.py``'s bearer
middleware guards only paths starting with ``/api/`` or ``/v1/``, so the
``/scim/v2`` mount needs NO auth-middleware exemption today — requests reach
this router untouched and authenticate here. Registering the surface is one
line in ``create_app``: ``app.include_router(scim_router)``. If the
middleware's path scope is ever widened, exempt this surface with
``if request.url.path.startswith(SCIM_PATH_PREFIX): return await
call_next(request)`` before the rejection logic, and resolve the caller via
:func:`resolve_scim_org`.

Deliberate minimalism, honestly surfaced:

- Users support the core lifecycle an IdP drives: filtered list, read,
  create (provision), replace/patch (``active: false`` triggers the core
  deprovisioning sweep with the org's standing key policy), and delete
  (same as deactivation). ``userName`` is the email.
- Groups answer 501 with a SCIM error naming the teams mapping as pending:
  teams are being built concurrently and this surface must not fake a
  mapping onto tables it does not own.
- Identity ownership is persisted at creation time only: the provision path
  writes ``account_provenance`` exactly when it created the ``auth.users``
  row itself. Linking an EXISTING account into the org adds a membership and
  never claims ownership.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Annotated, Protocol, cast

from fastapi import APIRouter, Depends, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from explabs.api.audit import AuditAction, record_audit_event
from explabs.api.capabilities import EnterpriseCapability, require_capability
from explabs.api.routes import ApiError, get_supabase
from explabs.api.services.deprovision import DeprovisionReport, deprovision_user_from_org
from explabs.api.tenancy import RequestActor
from explabs.db.repositories import JsonObject, SupabaseClient, find_one_by_columns, result_rows
from explabs.db.stores.api_key_store import hash_api_key

SCIM_PATH_PREFIX = "/scim/v2"

SCIM_MEDIA_TYPE = "application/scim+json"

_SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error"
_SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
_SCHEMA_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
_SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User"
_SCHEMA_SPC = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"
_SCHEMA_RESOURCE_TYPE = "urn:ietf:params:scim:schemas:core:2.0:ResourceType"
_SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema"

# The only filter shape shipped IdPs actually send on Users, and the only one
# this minimal server admits: userName eq "someone@example.com".
_USERNAME_EQ_FILTER = re.compile(r'^\s*userName\s+eq\s+"([^"]*)"\s*$', re.IGNORECASE)

_LIST_COUNT_CAP = 200


class ScimError(Exception):
    """A SCIM-protocol failure rendered in the RFC 7644 error envelope."""

    def __init__(self, status_code: int, detail: str, *, scim_type: str | None = None) -> None:
        """Capture the HTTP status, human detail, and optional scimType."""
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.scim_type = scim_type


def _scim_response(payload: JsonObject, *, status_code: int = 200) -> JSONResponse:
    """Serialize one SCIM payload with the SCIM media type."""
    return JSONResponse(payload, status_code=status_code, media_type=SCIM_MEDIA_TYPE)


def _scim_error_response(
    status_code: int, detail: str, scim_type: str | None = None
) -> JSONResponse:
    """Shape one RFC 7644 error envelope."""
    body: JsonObject = {
        "schemas": [_SCHEMA_ERROR],
        "status": str(status_code),
        "detail": detail,
    }
    if scim_type is not None:
        body["scimType"] = scim_type
    return _scim_response(body, status_code=status_code)


class _ScimRoute(APIRoute):
    """Route class that keeps every SCIM failure in the SCIM error envelope.

    Exception handlers are app-level in FastAPI and this surface must not
    touch ``app.py``, so the envelope conversion lives on the router itself:
    ``ScimError`` (protocol failures), ``ApiError`` (the capability gate's
    404, the sweep's guards), and body-validation failures all render as
    RFC 7644 errors instead of the platform's ``{"error": ...}`` shape.
    """

    def get_route_handler(self) -> Callable[[Request], Coroutine[object, object, Response]]:
        """Wrap the standard handler with SCIM envelope conversion."""
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                return await original(request)
            except ScimError as error:
                return _scim_error_response(error.status_code, error.detail, error.scim_type)
            except ApiError as error:
                return _scim_error_response(error.status_code, str(error))
            except RequestValidationError:
                return _scim_error_response(
                    400, "Request body is not valid SCIM JSON", "invalidSyntax"
                )

        return handler


router = APIRouter(prefix=SCIM_PATH_PREFIX, tags=["scim"], route_class=_ScimRoute)


def resolve_scim_org(request: Request) -> str | None:
    """Resolve a request's SCIM bearer to its org id, or None.

    The exported seam for any future middleware integration: pure hash lookup
    (no Vault round-trip) against live ``org_scim_tokens`` rows. Returns
    ``None`` for a missing, malformed, unknown, or revoked bearer — the
    caller decides how to reject.
    """
    authorization = request.headers.get("authorization")
    if authorization is None:
        return None
    scheme, _, credential = authorization.partition(" ")
    if scheme.lower() != "bearer" or not credential:
        return None
    row = _live_token_row(get_supabase(request), credential)
    return None if row is None else str(row["org_id"])


def _live_token_row(client: SupabaseClient, credential: str) -> JsonObject | None:
    """Fetch the unrevoked token row matching a presented bearer, if any."""
    result = (
        client.table("org_scim_tokens")
        .select("org_id, deprovision_key_policy")
        .eq("token_hash", hash_api_key(credential))
        .is_("revoked_at", "null")
        .limit(1)
        .execute()
    )
    rows = result_rows(result)
    return dict(rows[0]) if rows else None


@dataclass(frozen=True)
class ScimContext:
    """The org an authenticated SCIM request acts for, plus its key policy."""

    org_id: str
    key_policy: str


def _scim_context(request: Request) -> ScimContext:
    """Authenticate the SCIM bearer and gate on the SCIM capability.

    Raises:
        ScimError: 401 for a missing/unknown/revoked bearer (uniform detail,
            so probing cannot distinguish the cases).
        ApiError: 404 from the capability gate when the org is unlicensed
            (absent, not forbidden — rendered as a SCIM envelope upstream).
    """
    authorization = request.headers.get("authorization")
    credential: str | None = None
    if authorization is not None:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value:
            credential = value
    if credential is None:
        raise ScimError(401, "Authentication required")
    supabase = get_supabase(request)
    row = _live_token_row(supabase, credential)
    if row is None:
        raise ScimError(401, "Authentication required")
    org_id = str(row["org_id"])
    require_capability(supabase, org_id, EnterpriseCapability.SCIM)
    return ScimContext(org_id=org_id, key_policy=str(row["deprovision_key_policy"]))


Scim = Annotated[ScimContext, Depends(_scim_context)]
Client = Annotated[SupabaseClient, Depends(get_supabase)]


def _scim_actor(org_id: str) -> RequestActor:
    """The audit actor for SCIM-driven mutations: the org's token, no end user."""
    return RequestActor(
        user_id=f"scim:{org_id}",
        is_platform_admin=False,
        api_key_org_id=org_id,
        api_key_id=f"scim-token:{org_id}",
    )


# ---------------------------------------------------------------------------
# GoTrue admin boundary. The platform's SupabaseClient protocol deliberately
# covers only table/rpc/storage; user creation is the one SCIM operation that
# must cross into GoTrue, so it gets a narrow typed boundary here.


class _CreatedUser(Protocol):
    id: object


class _CreateUserResponse(Protocol):
    user: _CreatedUser | None


class _GoTrueAdmin(Protocol):
    def create_user(self, attributes: dict[str, object]) -> _CreateUserResponse: ...


def _gotrue_create_user(client: SupabaseClient, email: str) -> str:
    """Create one GoTrue account for a SCIM provision and return its id.

    The managed-provisioning metadata marker suppresses the self-serve signup
    trigger (personal org, starter examples): this path inserts the intended
    org membership itself. ``email_confirm`` is set because the IdP, not the
    platform, owns identity verification for a SCIM-provisioned account.
    """
    auth = getattr(client, "auth", None)
    admin = getattr(auth, "admin", None) if auth is not None else None
    if admin is None:
        msg = "GoTrue admin API is unavailable on this deployment"
        raise ScimError(502, msg)
    # Narrowest-boundary cast: the real supabase.Client.auth.admin satisfies
    # _GoTrueAdmin; fakes in tests provide the same two-attribute shape.
    response = cast("_GoTrueAdmin", admin).create_user(
        {
            "email": email,
            "email_confirm": True,
            "user_metadata": {"explabs_provisioned_via": "scim"},
        }
    )
    if response.user is None:
        msg = f"GoTrue did not return the created user for {email}"
        raise ScimError(502, msg)
    return str(response.user.id)


# ---------------------------------------------------------------------------
# Roster reads and resource projection.


def _org_roster(client: SupabaseClient, org_id: str) -> list[JsonObject]:
    """The org's members with emails, via the definer roster RPC."""
    result = client.rpc("org_members_with_emails", {"target_org_id": org_id}).execute()
    return [dict(row) for row in result_rows(result)]


def _roster_member(client: SupabaseClient, org_id: str, user_id: str) -> JsonObject | None:
    """One org member's roster row, or None when not a member."""
    for row in _org_roster(client, org_id):
        if str(row["user_id"]) == str(user_id):
            return row
    return None


def _user_resource(*, user_id: str, email: str, role: str, active: bool = True) -> JsonObject:
    """Project one org member onto the SCIM core User shape."""
    return {
        "schemas": [_SCHEMA_USER],
        "id": user_id,
        "userName": email,
        "active": active,
        "emails": [{"value": email, "primary": True}],
        "roles": [{"value": role, "primary": True}],
        "meta": {
            "resourceType": "User",
            "location": f"{SCIM_PATH_PREFIX}/Users/{user_id}",
        },
    }


def _list_response(resources: list[JsonObject], *, total: int, start_index: int) -> JsonObject:
    """Shape one RFC 7644 ListResponse envelope."""
    return {
        "schemas": [_SCHEMA_LIST],
        "totalResults": total,
        "startIndex": start_index,
        "itemsPerPage": len(resources),
        "Resources": resources,
    }


def _as_bool(value: object, *, attribute: str) -> bool:
    """Read one SCIM boolean, tolerating the string forms shipped IdPs send."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in {"true", "false"}:
        return value.lower() == "true"
    msg = f"{attribute} must be a boolean"
    raise ScimError(400, msg, scim_type="invalidValue")


def _scalar_uuid(data: object) -> str | None:
    """Read a uuid-returning RPC's result at the typed boundary.

    PostgREST returns a scalar-returning function's result BARE in ``data``
    (a string or null), while some client paths wrap it in a one-element
    list; mirror ``result_scalar_int``'s defensiveness for the uuid shape.
    """
    if isinstance(data, list):
        data = data[0] if data else None
    if data is None:
        return None
    if isinstance(data, str):
        return data or None
    msg = f"expected a uuid scalar from PostgREST, got {type(data).__name__}"
    raise ScimError(502, msg)


def _requested_role(body: JsonObject) -> str:
    """Map the SCIM roles attribute onto the org's two-role model."""
    roles = body.get("roles")
    if isinstance(roles, list):
        for entry in roles:
            entry_object = _json_object(entry)
            if entry_object is not None and str(entry_object.get("value", "")).lower() == "admin":
                return "admin"
    return "user"


def _json_object(value: object) -> JsonObject | None:
    """Read one nested JSON object at the typed boundary (None otherwise)."""
    if isinstance(value, dict):
        return {str(key): item for key, item in value.items()}
    return None


# ---------------------------------------------------------------------------
# Users.


@router.get("/Users")
def list_users(
    client: Client,
    scim: Scim,
    # `filter` shadows the builtin on purpose: it is the SCIM-mandated
    # query parameter name.
    filter: str | None = None,
    startIndex: int = 1,  # noqa: N803 - SCIM-mandated camelCase query parameter
    count: int = 100,
) -> JSONResponse:
    """List (optionally filtered) org members as SCIM Users.

    Supports exactly the ``userName eq "email"`` filter IdPs use to check
    for an existing account; any other filter is a 400 invalidFilter rather
    than a silently unfiltered list.
    """
    roster = _org_roster(client, scim.org_id)
    if filter is not None:
        match = _USERNAME_EQ_FILTER.match(filter)
        if match is None:
            msg = 'Only the filter userName eq "value" is supported'
            raise ScimError(400, msg, scim_type="invalidFilter")
        wanted = match.group(1).lower()
        roster = [row for row in roster if str(row.get("email", "")).lower() == wanted]
    start = max(startIndex, 1)
    page = roster[start - 1 : start - 1 + max(min(count, _LIST_COUNT_CAP), 0)]
    resources = [
        _user_resource(
            user_id=str(row["user_id"]),
            email=str(row.get("email") or ""),
            role=str(row["role"]),
        )
        for row in page
    ]
    return _scim_response(_list_response(resources, total=len(roster), start_index=start))


@router.get("/Users/{user_id}")
def get_user(user_id: str, client: Client, scim: Scim) -> JSONResponse:
    """Read one org member as a SCIM User (404 outside this org)."""
    row = _roster_member(client, scim.org_id, user_id)
    if row is None:
        msg = f"User not found: {user_id}"
        raise ScimError(404, msg)
    return _scim_response(
        _user_resource(
            user_id=str(row["user_id"]),
            email=str(row.get("email") or ""),
            role=str(row["role"]),
        )
    )


@router.post("/Users")
def create_user(body: JsonObject, client: Client, scim: Scim) -> JSONResponse:
    """Provision one user into the org (creating the account when absent).

    Ownership rule (E3, persisted never inferred): ``account_provenance`` is
    written exactly when this call created the ``auth.users`` row itself. An
    existing account is *linked* — membership only, no ownership claim, so a
    later deprovision stays membership-scoped for it.
    """
    email = str(body.get("userName") or "").strip().lower()
    if not email:
        msg = "userName (the email) is required"
        raise ScimError(400, msg, scim_type="invalidValue")
    if not _as_bool(body.get("active", True), attribute="active"):
        msg = "cannot provision a user with active=false"
        raise ScimError(400, msg, scim_type="invalidValue")
    role = _requested_role(body)

    lookup = client.rpc("admin_user_id_for_email", {"target_email": email}).execute()
    user_id = _scalar_uuid(lookup.data)
    created_account = False
    if user_id is not None:
        if find_one_by_columns(
            client, "organization_members", {"org_id": scim.org_id, "user_id": user_id}
        ):
            msg = f"User {email} is already provisioned in this organization"
            raise ScimError(409, msg, scim_type="uniqueness")
    else:
        user_id = _gotrue_create_user(client, email)
        created_account = True
        client.table("account_provenance").insert(
            {
                "user_id": user_id,
                "provisioned_by_org_id": scim.org_id,
                "provisioned_via": "scim",
            }
        ).execute()
    client.table("organization_members").insert(
        {"org_id": scim.org_id, "user_id": user_id, "role": role}
    ).execute()
    record_audit_event(
        client,
        actor=_scim_actor(scim.org_id),
        org_id=scim.org_id,
        action=AuditAction.SCIM_USER_PROVISION,
        object_type="member",
        object_id=user_id,
        after={"userName": email, "role": role, "created_account": created_account},
        context={"surface": "scim"},
    )
    return _scim_response(_user_resource(user_id=user_id, email=email, role=role), status_code=201)


def _deactivate(client: SupabaseClient, scim: ScimContext, user_id: str) -> DeprovisionReport:
    """Run the core sweep for one SCIM deactivation and audit the SCIM verb."""
    key_policy: str = scim.key_policy
    if key_policy not in ("revoke", "keep"):  # pragma: no cover - DB CHECK enforces this
        msg = f"invalid org key policy: {key_policy}"
        raise ScimError(500, msg)
    report = deprovision_user_from_org(
        client,
        org_id=scim.org_id,
        user_id=user_id,
        actor=_scim_actor(scim.org_id),
        key_policy="revoke" if key_policy == "revoke" else "keep",
    )
    record_audit_event(
        client,
        actor=_scim_actor(scim.org_id),
        org_id=scim.org_id,
        action=AuditAction.SCIM_USER_DEPROVISION,
        object_type="member",
        object_id=str(user_id),
        after=report.model_dump(),
        context={"surface": "scim"},
    )
    return report


@router.put("/Users/{user_id}")
def replace_user(user_id: str, body: JsonObject, client: Client, scim: Scim) -> JSONResponse:
    """Replace one User; ``active: false`` triggers the deprovisioning sweep.

    Attribute edits beyond ``active`` are not persisted (the IdP owns the
    identity attributes; the platform stores none of them beyond email), so a
    still-active replace echoes the member's current state.
    """
    row = _roster_member(client, scim.org_id, user_id)
    if row is None:
        msg = f"User not found: {user_id}"
        raise ScimError(404, msg)
    email = str(row.get("email") or "")
    if not _as_bool(body.get("active", True), attribute="active"):
        _deactivate(client, scim, user_id)
        return _scim_response(
            _user_resource(user_id=user_id, email=email, role=str(row["role"]), active=False)
        )
    return _scim_response(_user_resource(user_id=user_id, email=email, role=str(row["role"])))


def _patch_sets_active(body: JsonObject) -> bool | None:
    """Extract the final ``active`` state a PatchOp requests, if any."""
    operations = body.get("Operations")
    if not isinstance(operations, list):
        msg = "PatchOp requires an Operations list"
        raise ScimError(400, msg, scim_type="invalidValue")
    active: bool | None = None
    for operation in operations:
        operation_object = _json_object(operation)
        if operation_object is None:
            continue
        op = str(operation_object.get("op", "")).lower()
        if op != "replace":
            continue
        path = str(operation_object.get("path", "") or "").strip().lower()
        value = operation_object.get("value")
        value_object = _json_object(value)
        if path == "active":
            active = _as_bool(value, attribute="active")
        elif path == "" and value_object is not None and "active" in value_object:
            active = _as_bool(value_object["active"], attribute="active")
    return active


@router.patch("/Users/{user_id}")
def patch_user(user_id: str, body: JsonObject, client: Client, scim: Scim) -> JSONResponse:
    """Patch one User; a replace of ``active`` to false deprovisions them."""
    row = _roster_member(client, scim.org_id, user_id)
    if row is None:
        msg = f"User not found: {user_id}"
        raise ScimError(404, msg)
    active = _patch_sets_active(body)
    email = str(row.get("email") or "")
    if active is False:
        _deactivate(client, scim, user_id)
        return _scim_response(
            _user_resource(user_id=user_id, email=email, role=str(row["role"]), active=False)
        )
    return _scim_response(_user_resource(user_id=user_id, email=email, role=str(row["role"])))


@router.delete("/Users/{user_id}", status_code=204)
def delete_user(user_id: str, client: Client, scim: Scim) -> Response:
    """Delete = deactivate: run the sweep, never touch the global account."""
    if _roster_member(client, scim.org_id, user_id) is None:
        msg = f"User not found: {user_id}"
        raise ScimError(404, msg)
    _deactivate(client, scim, user_id)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Groups: honestly unimplemented until the teams tables land.

_GROUPS_PENDING_DETAIL = (
    "Groups are not implemented yet: the SCIM group mapping targets "
    "organization teams, which are still being built. Sync Users only."
)


@router.get("/Groups")
@router.post("/Groups")
def groups_collection(scim: Scim) -> JSONResponse:
    """Groups sync is pending the teams mapping; answer 501, never fake."""
    _ = scim
    return _scim_error_response(501, _GROUPS_PENDING_DETAIL)


@router.get("/Groups/{group_id}")
@router.put("/Groups/{group_id}")
@router.patch("/Groups/{group_id}")
@router.delete("/Groups/{group_id}")
def groups_resource(group_id: str, scim: Scim) -> JSONResponse:
    """Single-Group operations answer the same 501 as the collection."""
    _ = group_id, scim
    return _scim_error_response(501, _GROUPS_PENDING_DETAIL)


# ---------------------------------------------------------------------------
# Discovery endpoints (static, RFC 7643 §5-7).


@router.get("/ServiceProviderConfig")
def service_provider_config(scim: Scim) -> JSONResponse:
    """Advertise exactly the features this server implements."""
    _ = scim
    return _scim_response(
        {
            "schemas": [_SCHEMA_SPC],
            "documentationUri": "https://experientiallabs.ai/docs",
            "patch": {"supported": True},
            "bulk": {"supported": False, "maxOperations": 0, "maxPayloadSize": 0},
            "filter": {"supported": True, "maxResults": _LIST_COUNT_CAP},
            "changePassword": {"supported": False},
            "sort": {"supported": False},
            "etag": {"supported": False},
            "authenticationSchemes": [
                {
                    "type": "oauthbearertoken",
                    "name": "OAuth Bearer Token",
                    "description": "The organization's SCIM bearer token",
                }
            ],
        }
    )


@router.get("/ResourceTypes")
def resource_types(scim: Scim) -> JSONResponse:
    """Advertise the User resource only: Groups are pending (501 above)."""
    _ = scim
    user_type: JsonObject = {
        "schemas": [_SCHEMA_RESOURCE_TYPE],
        "id": "User",
        "name": "User",
        "endpoint": "/Users",
        "schema": _SCHEMA_USER,
        "meta": {"resourceType": "ResourceType"},
    }
    return _scim_response(_list_response([user_type], total=1, start_index=1))


@router.get("/Schemas")
def schemas(scim: Scim) -> JSONResponse:
    """Describe the attributes of the User resource this server serves."""
    _ = scim
    user_schema: JsonObject = {
        "schemas": [_SCHEMA_SCHEMA],
        "id": _SCHEMA_USER,
        "name": "User",
        "description": "Organization member (userName is the email)",
        "attributes": [
            {
                "name": "userName",
                "type": "string",
                "multiValued": False,
                "required": True,
                "caseExact": False,
                "mutability": "immutable",
                "returned": "default",
                "uniqueness": "server",
            },
            {
                "name": "active",
                "type": "boolean",
                "multiValued": False,
                "required": False,
                "mutability": "readWrite",
                "returned": "default",
            },
            {
                "name": "emails",
                "type": "complex",
                "multiValued": True,
                "required": False,
                "mutability": "readOnly",
                "returned": "default",
            },
            {
                "name": "roles",
                "type": "complex",
                "multiValued": True,
                "required": False,
                "mutability": "readWrite",
                "returned": "default",
            },
        ],
        "meta": {"resourceType": "Schema"},
    }
    return _scim_response(_list_response([user_schema], total=1, start_index=1))
