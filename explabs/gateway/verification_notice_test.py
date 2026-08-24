# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the credit spend-gate customer message helpers."""

from __future__ import annotations

import hashlib
import uuid
from typing import cast

import pytest

from explabs.gateway.conftest import GatewayHarness
from explabs.gateway.db import GatewayDatabase
from explabs.gateway.verification_notice import (
    VERIFY_EMAIL_CODE,
    VERIFY_EMAIL_MESSAGE,
    apply_verify_email_notice,
    is_insufficient_quota_envelope,
    org_owner_unverified_for_key,
)


def test_is_insufficient_quota_envelope_matches_type_or_code() -> None:
    """An OpenAI envelope keyed by quota type OR code is recognized."""
    assert is_insufficient_quota_envelope({"error": {"type": "insufficient_quota"}})
    assert is_insufficient_quota_envelope({"error": {"code": "insufficient_quota"}})


def test_is_insufficient_quota_envelope_rejects_other_shapes() -> None:
    """Non-quota errors and malformed bodies are not treated as quota envelopes."""
    assert not is_insufficient_quota_envelope({"error": {"type": "invalid_request_error"}})
    assert not is_insufficient_quota_envelope({"error": "insufficient_quota"})
    assert not is_insufficient_quota_envelope({"not_error": {}})
    assert not is_insufficient_quota_envelope("insufficient_quota")


def test_apply_verify_email_notice_rewrites_message_and_code_only() -> None:
    """The notice replaces message and code but keeps the insufficient_quota type."""
    body: dict[str, object] = {
        "error": {
            "type": "insufficient_quota",
            "code": "insufficient_quota",
            "message": "monthly gateway allocation is exhausted",
            "param": None,
        }
    }
    rewritten = apply_verify_email_notice(body)
    error = rewritten["error"]
    assert isinstance(error, dict)
    typed = cast("dict[str, object]", error)
    # The message and code become actionable; the HTTP-class type stays a quota
    # condition so official clients still treat it as a 429 quota.
    assert typed["message"] == VERIFY_EMAIL_MESSAGE
    assert typed["code"] == VERIFY_EMAIL_CODE
    assert typed["type"] == "insufficient_quota"


def test_verify_email_message_names_the_action_and_the_unaffected_paths() -> None:
    """The customer copy states the action and reassures BYOK still works."""
    # Requirement: the copy must say to verify the email AND reassure that BYOK
    # and trace uploads still work, so it never reads as a dead end.
    assert "verify your email" in VERIFY_EMAIL_MESSAGE.lower()
    assert "byok" in VERIFY_EMAIL_MESSAGE.lower()


def _seed_admin_owner(db: GatewayDatabase, *, org_id: str) -> tuple[str, str]:
    """Insert an auth.users owner and founding admin membership for ``org_id``.

    Login state (email_confirmed_at) is set, as signup now does eagerly; whether
    the org can SPEND is governed by organizations.spend_unlocked_at, which the
    org row already carries (null by default = spend-locked). Returns
    ``(user_id, email)``. Caller is responsible for teardown.
    """
    user_id = str(uuid.uuid4())
    email = f"verify-notice-{user_id[:8]}@pytest.example"
    with db.transaction() as cursor:
        cursor.execute(
            "insert into auth.users (id, email, email_confirmed_at) values (%s, %s, now())",
            (user_id, email),
        )
        cursor.execute(
            "insert into public.organization_members (org_id, user_id, role) "
            "values (%s, %s, 'admin')",
            (org_id, user_id),
        )
    return user_id, email


def _remove_owner(db: GatewayDatabase, *, org_id: str, user_id: str) -> None:
    with db.transaction() as cursor:
        cursor.execute(
            "delete from public.organization_members where org_id = %s and user_id = %s",
            (org_id, user_id),
        )
        cursor.execute("delete from auth.users where id = %s", (user_id,))


@pytest.mark.integration
def test_org_owner_unverified_tracks_spend_unlocked_at(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A founded org is spend-locked until organizations.spend_unlocked_at is set."""
    org_id = gateway_harness.seed_org()
    seeded = gateway_harness.seed_key(org_id=org_id)
    user_id, _email = _seed_admin_owner(gateway_db, org_id=org_id)
    try:
        # Spend-locked owner (spend_unlocked_at null): the key's org draws the
        # verify-email notice even though the user can log in.
        assert org_owner_unverified_for_key(gateway_db, seeded.raw_key) is True
        # Unlocking spend closes the gate, so the notice no longer applies.
        with gateway_db.transaction() as cursor:
            cursor.execute(
                "update public.organizations set spend_unlocked_at = now() where id = %s",
                (org_id,),
            )
        assert org_owner_unverified_for_key(gateway_db, seeded.raw_key) is False
    finally:
        _remove_owner(gateway_db, org_id=org_id, user_id=user_id)


@pytest.mark.integration
def test_org_owner_unverified_is_false_for_memberless_and_unknown_keys(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A memberless org and an unknown key never draw the verify-email notice."""
    org_id = gateway_harness.seed_org()
    seeded = gateway_harness.seed_key(org_id=org_id)
    # No membership seeded: a memberless org (fixtures/seed shape) is never gated.
    assert org_owner_unverified_for_key(gateway_db, seeded.raw_key) is False
    # An unknown key matches no org, so it never invents a notice.
    unknown = "xpl_" + hashlib.sha256(b"nope").hexdigest()
    assert org_owner_unverified_for_key(gateway_db, unknown) is False
