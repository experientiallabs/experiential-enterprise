# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Customer-facing message for the credit spend gate (P1025).

The gate lives in ``gateway_start_attempt`` (migration
20260826000000_decouple_spend_gate_from_login): an org whose founding admin has
not yet unlocked spending -- ``organizations.spend_unlocked_at is null`` -- cannot
draw PLATFORM credits, and the host-lane reservation is refused with SQLSTATE
``P1025``. Spend is unlocked when the founder proves inbox ownership by clicking
the verification link, independent of login (login is permitted from signup).
wmo's executor
collapses every team-scope budget refusal to one generic ``429
insufficient_quota`` whose message ("monthly gateway allocation is exhausted")
does not say WHY. wmo is a pinned dependency the platform never edits, so this
module restores the actionable message at the explabs serving boundary — the
only place that still knows the org and can tell an unverified owner apart from a
genuinely exhausted balance.

The discriminator is cheap and correct: the message is only ever applied to a
response that is ALREADY a 429 insufficient_quota, i.e. routing was refused on a
team-scope gate. The P1025 gate fires FIRST in the host block (before the
balance/cap/budget checks), so if the org's founding admin is unverified, that
refusal IS the reason; a verified org that 429s hit balance/budget instead and
keeps the generic quota message.
"""

from __future__ import annotations

import hashlib
from typing import cast

from explabs.gateway.db import GatewayDatabase

# Stable machine-readable code the dashboard/playground and API clients can
# branch on; the HTTP class stays 429 insufficient_quota so official OpenAI and
# Anthropic clients still treat it as a quota condition.
VERIFY_EMAIL_CODE = "email_unverified"
VERIFY_EMAIL_MESSAGE = (
    "Verify your email to use your credits: check your inbox for the verification "
    "link, then retry. Everything else works now, including your own provider keys "
    "(BYOK) and trace uploads."
)


def org_owner_unverified_for_key(db: GatewayDatabase, raw_key: str) -> bool:
    """Whether the org that owns ``raw_key`` is still spend-locked.

    One read mirroring ``gateway_start_attempt``'s P1025 ``exists`` clause, keyed
    by the presented key's SHA-256 (the same hash ``api_keys.key_hash`` stores).
    The gate fires when the org has a founding admin AND its
    ``organizations.spend_unlocked_at`` is null, so a membership-less
    fixture/seed org is never flagged -- exactly the SQL gate's shape.

    Args:
        db: Shared worker connection pool.
        raw_key: The presented gateway key, verbatim from the request.

    Returns:
        ``True`` only when a present founding admin's org has not unlocked
        spending. Any lookup failure returns ``False`` so a hiccup never invents
        a verify-email notice for a genuine quota exhaustion.
    """
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    try:
        with db.transaction() as cursor:
            cursor.execute(
                """
                select exists (
                  select 1
                    from public.api_keys keys
                    join public.organization_members members
                      on members.org_id = keys.org_id and members.role = 'admin'
                    join public.organizations orgs on orgs.id = keys.org_id
                   where keys.key_hash = %s
                     and orgs.spend_unlocked_at is null
                )
                """,
                (key_hash,),
            )
            row = cursor.fetchone()
    except Exception:  # noqa: BLE001 - a notice is best-effort; never fail a response
        return False
    return bool(row and row[0])


def is_insufficient_quota_envelope(body: object) -> bool:
    """Whether ``body`` is an OpenAI error envelope for insufficient quota."""
    if not isinstance(body, dict):
        return False
    error = cast("dict[str, object]", body).get("error")
    if not isinstance(error, dict):
        return False
    typed = cast("dict[str, object]", error)
    return typed.get("type") == "insufficient_quota" or typed.get("code") == "insufficient_quota"


def apply_verify_email_notice(body: dict[str, object]) -> dict[str, object]:
    """Rewrite an OpenAI insufficient-quota envelope to the verify-email message.

    Mutates and returns the envelope in place: the HTTP status and error ``type``
    stay ``insufficient_quota``; only the human ``message`` and machine ``code``
    change so a client can tell "verify your email" from "balance exhausted".
    """
    error = body.get("error")
    if isinstance(error, dict):
        typed = cast("dict[str, object]", error)
        typed["message"] = VERIFY_EMAIL_MESSAGE
        typed["code"] = VERIFY_EMAIL_CODE
    return body
