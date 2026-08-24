# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Persistence for domain-based organization join requests.

Two operator/tenant surfaces share this store, all as ``service_role``:

* ``org_domains`` -- verified-domain -> org associations. Platform admins
  assert them directly (trusted, stamped verified on insert); org admins may
  also self-claim a domain through the E2 SSO surface, where it stays inert
  until a DNS-TXT lookup proves control (only VERIFIED rows drive join
  offers or SSO).
* ``org_join_requests`` -- a requester's pending/decided request to join the
  org their verified email domain matches, and the admin approve/deny that
  grants membership.

Approval settles the request and inserts the ``organization_members`` row (at
``user`` role, the same table ``apps/web/lib/members/manage.ts`` writes for
"add an existing account") atomically through the ``approve_org_join_request``
definer function, so a crash can never approve without granting or grant
without recording the decision.

Reading a user's email/verification state needs ``auth.users``, which RLS
clients cannot reach, so that one read goes through the definer
``auth_user_verification`` RPC; everything else is plain table access.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import (
    DeleteCapableQuery,
    RepositoryError,
    SupabaseClient,
    is_unique_violation,
    result_rows,
)
from explabs.db.stores.transitions import now_iso

_DOMAIN_COLUMNS = "id, org_id, domain, created_at"
_REQUEST_COLUMNS = "id, org_id, user_id, email, status, created_at, decided_at, decided_by"


class DuplicateOrgDomainError(Exception):
    """Raised when a domain is already associated with some organization."""


class DuplicatePendingRequestError(Exception):
    """Raised when the user already has a pending request for the org."""


class OrgDomainRecord(BaseModel):
    """Typed snapshot of an ``org_domains`` row."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    domain: str
    created_at: str


class JoinRequestRecord(BaseModel):
    """Typed snapshot of an ``org_join_requests`` row."""

    model_config = ConfigDict(frozen=True)

    id: str
    org_id: str
    user_id: str
    email: str
    status: str
    created_at: str
    # Null until a decision lands; defaulted so a freshly inserted row (which
    # carries only the pending columns) validates the same as a re-read row.
    decided_at: str | None = None
    decided_by: str | None = None


class UserVerification(BaseModel):
    """One user's email and whether they have PROVEN inbox ownership.

    ``inbox_proven`` is NOT the raw ``auth.users.email_confirmed_at`` login flag
    (set eagerly at signup so a user can log in); it is the decoupled inbox-proof
    signal -- the user's founding org has ``spend_unlocked_at`` set -- so the
    domain-join gate cannot be passed by an unproven instant signup.
    """

    model_config = ConfigDict(frozen=True)

    email: str
    inbox_proven: bool


def email_domain(email: str) -> str | None:
    """Return the lowercased domain of an email, or ``None`` if malformed.

    A well-formed address has exactly one ``@`` with a non-empty local part and
    a domain carrying at least one dot; anything else yields ``None`` so the
    caller offers no join.
    """
    local, _, domain = email.strip().rpartition("@")
    if not local or "@" in local:
        return None
    domain = domain.lower()
    if "." not in domain or domain.startswith(".") or domain.endswith("."):
        return None
    return domain


class OrgJoinStore:
    """Reads and writes over the domain-association and join-request tables."""

    def __init__(self, client: SupabaseClient) -> None:
        """Bind the store to a Supabase client (service_role in production)."""
        self._client = client

    # -- Domain associations --------------------------------------------------

    def find_domain(self, domain: str) -> OrgDomainRecord | None:
        """Return the VERIFIED org association for a domain, if one exists.

        Unverified rows are org-admin self-service claims awaiting DNS-TXT
        proof (E2 SSO substrate, 20260901140000): an unproved claim must never
        drive a join offer, or a squatter claim would misroute requesters.
        Operator-asserted rows are backfilled verified, so this filter changes
        nothing for them.
        """
        rows = result_rows(
            self._client.table("org_domains")
            .select(_DOMAIN_COLUMNS)
            .eq("domain", domain.lower())
            .not_.is_("verified_at", "null")
            .limit(1)
            .execute()
        )
        if not rows:
            return None
        return OrgDomainRecord.model_validate(rows[0])

    def list_org_domains(self, org_id: str) -> tuple[OrgDomainRecord, ...]:
        """Return an org's domain associations, oldest first."""
        rows = result_rows(
            self._client.table("org_domains")
            .select(_DOMAIN_COLUMNS)
            .eq("org_id", org_id)
            .order("created_at", desc=False)
            .execute()
        )
        return tuple(OrgDomainRecord.model_validate(row) for row in rows)

    def add_org_domain(
        self, *, org_id: str, domain: str, created_by: str | None
    ) -> OrgDomainRecord:
        """Associate a domain with an org.

        Raises:
            DuplicateOrgDomainError: If the domain is already associated with
                any organization (the global unique index).
        """
        stamp = now_iso()
        try:
            rows = result_rows(
                self._client.table("org_domains")
                .insert(
                    {
                        "org_id": org_id,
                        "domain": domain.lower(),
                        "created_by": created_by,
                        "created_at": stamp,
                        # Operator assertion IS the trust decision: the row is
                        # verified at birth, exactly like the pre-E2 backfill.
                        "verified_at": stamp,
                    }
                )
                .execute()
            )
        except Exception as error:
            if is_unique_violation(error):
                msg = f"domain already associated with an organization: {domain.lower()}"
                raise DuplicateOrgDomainError(msg) from error
            raise
        return OrgDomainRecord.model_validate(rows[0])

    def delete_org_domain(self, *, org_id: str, domain_id: str) -> bool:
        """Remove one domain association; return whether a row was deleted."""
        query = self._client.table("org_domains")
        if not isinstance(query, DeleteCapableQuery):
            msg = "Supabase query builder does not support delete"
            raise RepositoryError(msg)
        rows = result_rows(query.delete().eq("org_id", org_id).eq("id", domain_id).execute())
        return bool(rows)

    # -- Requester state ------------------------------------------------------

    def user_verification(self, user_id: str) -> UserVerification | None:
        """Return a user's email + inbox-proof state, or ``None`` if unknown."""
        rows = result_rows(
            self._client.rpc("auth_user_verification", {"target_user_id": user_id}).execute()
        )
        if not rows:
            return None
        row = rows[0]
        raw_email = row.get("email")
        if not isinstance(raw_email, str):
            msg = f"auth_user_verification returned no email for {user_id}"
            raise RepositoryError(msg)
        return UserVerification(
            email=raw_email,
            inbox_proven=row.get("inbox_proven") is True,
        )

    def is_member(self, org_id: str, user_id: str) -> bool:
        """Return whether the user already belongs to the org."""
        rows = result_rows(
            self._client.table("organization_members")
            .select("user_id")
            .eq("org_id", org_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        return bool(rows)

    def latest_request(self, org_id: str, user_id: str) -> JoinRequestRecord | None:
        """Return the user's most recent request for the org, if any."""
        rows = result_rows(
            self._client.table("org_join_requests")
            .select(_REQUEST_COLUMNS)
            .eq("org_id", org_id)
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if not rows:
            return None
        return JoinRequestRecord.model_validate(rows[0])

    def create_request(self, *, org_id: str, user_id: str, email: str) -> JoinRequestRecord:
        """Open one pending join request.

        Raises:
            DuplicatePendingRequestError: If the user already has a pending
                request for this org (the partial unique index).
        """
        stamp = now_iso()
        try:
            rows = result_rows(
                self._client.table("org_join_requests")
                .insert(
                    {
                        "org_id": org_id,
                        "user_id": user_id,
                        "email": email,
                        "status": "pending",
                        "created_at": stamp,
                    }
                )
                .execute()
            )
        except Exception as error:
            if is_unique_violation(error):
                msg = "a pending join request already exists"
                raise DuplicatePendingRequestError(msg) from error
            raise
        return JoinRequestRecord.model_validate(rows[0])

    # -- Admin surface --------------------------------------------------------

    def get_request(self, request_id: str) -> JoinRequestRecord | None:
        """Return one request by id, if it exists."""
        rows = result_rows(
            self._client.table("org_join_requests")
            .select(_REQUEST_COLUMNS)
            .eq("id", request_id)
            .limit(1)
            .execute()
        )
        if not rows:
            return None
        return JoinRequestRecord.model_validate(rows[0])

    def list_pending_requests(self, org_id: str) -> tuple[JoinRequestRecord, ...]:
        """Return an org's pending requests, oldest first."""
        rows = result_rows(
            self._client.table("org_join_requests")
            .select(_REQUEST_COLUMNS)
            .eq("org_id", org_id)
            .eq("status", "pending")
            .order("created_at", desc=False)
            .execute()
        )
        return tuple(JoinRequestRecord.model_validate(row) for row in rows)

    def approve_request(self, request: JoinRequestRecord, *, decided_by: str) -> JoinRequestRecord:
        """Mark the request approved and grant membership in one transaction.

        Delegates to the ``approve_org_join_request`` definer function so the
        status transition and the ``organization_members`` grant commit
        atomically: a crash can never approve a request without granting access,
        nor grant access without recording the decision. A request that already
        settled (a concurrent deny, or a replay) is returned unchanged and
        grants nothing.
        """
        rows = result_rows(
            self._client.rpc(
                "approve_org_join_request",
                {"p_request_id": request.id, "p_decided_by": decided_by},
            ).execute()
        )
        if not rows:
            msg = f"join request vanished during approval: {request.id}"
            raise RepositoryError(msg)
        return JoinRequestRecord.model_validate(rows[0])

    def deny_request(self, request: JoinRequestRecord, *, decided_by: str) -> JoinRequestRecord:
        """Mark the request denied; nothing else changes."""
        return self._decide(request.id, status="denied", decided_by=decided_by)

    def _decide(self, request_id: str, *, status: str, decided_by: str) -> JoinRequestRecord:
        """Transition a still-pending request to a decided status.

        The ``status = 'pending'`` guard makes the decision idempotent under a
        concurrent approve/deny: only the first writer matches, and a caller
        that lost the race re-reads the settled row.
        """
        rows = result_rows(
            self._client.table("org_join_requests")
            .update({"status": status, "decided_at": now_iso(), "decided_by": decided_by})
            .eq("id", request_id)
            .eq("status", "pending")
            .execute()
        )
        if rows:
            return JoinRequestRecord.model_validate(rows[0])
        settled = self.get_request(request_id)
        if settled is None:
            msg = f"join request vanished during decision: {request_id}"
            raise RepositoryError(msg)
        return settled
