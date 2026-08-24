# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The audit-event emit seam for control-plane mutations (design F2/E7).

Every mutating route handler calls :func:`record_audit_event` exactly once
after its mutation commits, passing the actor it already resolved and the
changed-fields payload it already holds. The helper derives the persisted
``actor_kind``/``actor_id`` pair from the request actor, strips secret-shaped
keys from the snapshots, and writes through the ``record_audit_event`` definer
RPC (the explicit-emit design: sensitive writes arrive over service-role,
where a trigger could never recover the actor).

Deliberate trade-off: an audit write failure logs loudly but never fails the
customer mutation — the mutation has already committed, and pre-launch the
product favors availability over audit completeness. Revisit for a compliance
mode where the audit row must land transactionally with the write.
"""

from __future__ import annotations

import enum
import logging
import re

from explabs.api.tenancy import RequestActor
from explabs.db.repositories import JsonObject, SupabaseClient

logger = logging.getLogger(__name__)

# Snapshot keys that could carry secret material never reach the audit row.
_SENSITIVE_KEY_PATTERN = re.compile(r"secret|token|credential|password", re.IGNORECASE)


class AuditAction(enum.StrEnum):
    """The dot-namespaced action registry, seeded from the mutation inventory.

    One member per control-plane mutation; the value is the stable string
    persisted in ``audit_log.action``. Extending the API surface with a new
    mutation means adding its action here and emitting it from the handler.
    """

    KEYS_LIMITS_SET = "keys.limits_set"
    ALIASES_CREATE = "aliases.create"
    ALIASES_REPOINT = "aliases.repoint"
    ALIASES_ROLLBACK = "aliases.rollback"
    ALIASES_RETIRE = "aliases.retire"
    IDENTITIES_CREATE = "identities.create"
    IDENTITIES_UPDATE = "identities.update"
    IDENTITIES_DISABLE = "identities.disable"
    GRANTS_ADD = "grants.add"
    GRANTS_REMOVE = "grants.remove"
    BUDGETS_SET = "budgets.set"
    BUDGETS_DELETE = "budgets.delete"
    ORG_DATA_DELETE = "org.data_delete"
    ORG_TRAINING_CAP_SET = "org.training_cap_set"
    BILLING_FREE_CREDIT_CAPS_SET = "billing.free_credit_caps_set"
    BILLING_CREDIT_GRANT = "billing.credit_grant"
    BYOK_UPSERT = "byok.upsert"
    BYOK_STATUS_CHECK = "byok.status_check"
    BYOK_DEPLOYMENT_CHECK = "byok.deployment_check"
    BYOK_SPEND_REFRESH = "byok.spend_refresh"
    MODELS_CREATE = "models.create"
    MODELS_PROVIDER_ADD = "models.provider_add"
    MODELS_WATERFALL_SET = "models.waterfall_set"
    PROJECTS_CREATE = "projects.create"
    PROJECTS_UPDATE = "projects.update"
    PROJECTS_ARCHIVE = "projects.archive"
    PROJECTS_SETUP_SET = "projects.setup_set"
    PROJECTS_SERVING_SETTINGS_SET = "projects.serving_settings_set"
    JOBS_PREPARATION_ENQUEUE = "jobs.preparation_enqueue"
    JOBS_ENQUEUE = "jobs.enqueue"
    JOBS_CANCEL = "jobs.cancel"
    TRACES_UPLOAD = "traces.upload"
    TRACES_ACQUIRE = "traces.acquire"
    TRACES_RETRY = "traces.retry"
    RELEASE_FAULT_SET = "release_fault.set"
    RELEASE_FAULT_RELEASE = "release_fault.release"
    RELEASE_FAULT_CLEAR = "release_fault.clear"
    USAGE_IMPORT = "usage.import"
    YC_CLAIM = "yc.claim"
    ORG_DOMAINS_CREATE = "org_domains.create"
    ORG_DOMAINS_VERIFY = "org_domains.verify"
    ORG_DOMAINS_DELETE = "org_domains.delete"
    SSO_PROVIDER_SET = "sso.provider_set"
    SSO_PROVIDER_DELETE = "sso.provider_delete"
    SSO_REQUIRED_SET = "sso.required_set"
    TEAMS_CREATE = "teams.create"
    TEAMS_RENAME = "teams.rename"
    TEAMS_DELETE = "teams.delete"
    TEAMS_MEMBER_ADD = "teams.member_add"
    TEAMS_MEMBER_REMOVE = "teams.member_remove"
    TEAMS_KEY_ASSIGN = "teams.key_assign"
    SCIM_TOKEN_MINT = "scim.token_mint"
    SCIM_TOKEN_REVOKE = "scim.token_revoke"
    SCIM_USER_PROVISION = "scim.user_provision"
    SCIM_USER_DEPROVISION = "scim.user_deprovision"
    SCIM_GROUP_SYNC = "scim.group_sync"
    MEMBERS_DEPROVISION = "members.deprovision"
    PROVIDER_POLICY_SET = "provider_policy.set"
    PROVIDER_POLICY_DELETE = "provider_policy.delete"
    ENTITLEMENTS_GRANT = "entitlements.grant"
    ENTITLEMENTS_REVOKE = "entitlements.revoke"


def redact_snapshot(snapshot: JsonObject | None) -> JsonObject | None:
    """Drop secret-shaped keys from a before/after snapshot, recursively.

    Args:
        snapshot: Raw changed-fields payload a handler holds, or ``None``.

    Returns:
        The snapshot without any key whose name contains ``secret``,
        ``token``, ``credential``, or ``password`` (case-insensitive), at any
        nesting depth; ``None`` passes through.
    """
    if snapshot is None:
        return None
    return {
        key: _redact_value(value)
        for key, value in snapshot.items()
        if _SENSITIVE_KEY_PATTERN.search(key) is None
    }


def _redact_value(value: object) -> object:
    """Redact nested dicts and lists inside one snapshot value."""
    if isinstance(value, dict):
        # Nested JSON objects at any depth get the same key filter.
        return redact_snapshot({str(key): item for key, item in value.items()})
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    return value


def _actor_identity(actor: RequestActor | None) -> tuple[str, str | None]:
    """Derive the persisted (actor_kind, actor_id) pair from a request actor."""
    match actor:
        case None:
            # Background/worker writes carry no request actor.
            return "system", None
        case RequestActor(api_key_org_id=str() as key_org):
            # A key-authenticated caller has no end user: the key is the
            # actor, identified by its row id when the middleware recorded
            # one, else by the org the key serves.
            return "api_key", actor.api_key_id or key_org
        case RequestActor(is_platform_admin=True):
            return "platform_admin", actor.user_id
        case _:
            return "user", actor.user_id


def record_audit_event(
    client: SupabaseClient,
    *,
    actor: RequestActor | None,
    org_id: str,
    action: AuditAction,
    object_type: str,
    object_id: str,
    before: JsonObject | None = None,
    after: JsonObject | None = None,
    context: JsonObject | None = None,
) -> None:
    """Emit one audit event through the ``record_audit_event`` definer RPC.

    Called at the end of every mutating handler, after the mutation
    succeeded. Never raises: an audit write failure logs loudly but does not
    fail the customer mutation that already committed (deliberate pre-launch
    trade-off — revisit for compliance mode, where audit completeness must
    win over availability).

    Args:
        client: Service-role Supabase client.
        actor: The resolved request actor, or ``None`` for system writes.
        org_id: Organization the mutated object belongs to.
        action: Registry action naming the mutation.
        object_type: Kind of object mutated (e.g. ``"alias"``).
        object_id: Stable identifier of the mutated object.
        before: Prior state, when the handler already held it (redacted).
        after: Changed-fields payload the handler already holds (redacted).
        context: Optional request context (ip, path, surface).
    """
    actor_kind, actor_id = _actor_identity(actor)
    try:
        client.rpc(
            "record_audit_event",
            {
                "p_org_id": org_id,
                "p_actor_kind": actor_kind,
                "p_actor_id": actor_id,
                "p_action": action.value,
                "p_object_type": object_type,
                "p_object_id": object_id,
                "p_before": redact_snapshot(before),
                "p_after": redact_snapshot(after),
                "p_context": context,
            },
        ).execute()
    except Exception:
        logger.exception(
            "Audit event write failed: action=%s org=%s object=%s/%s",
            action.value,
            org_id,
            object_type,
            object_id,
        )
