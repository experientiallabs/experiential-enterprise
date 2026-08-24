# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the promo->credits transition customer message helpers."""

from __future__ import annotations

import hashlib
import uuid
from typing import cast

import pytest

from explabs.gateway.conftest import GatewayHarness
from explabs.gateway.db import GatewayDatabase
from explabs.gateway.promo_notice import (
    PROMO_CREDITS_NOW_CODE,
    apply_promo_exhausted_notice,
    promo_exhausted_label_for_key,
    promo_exhausted_message,
)


def test_promo_exhausted_message_names_promo_and_credits_and_byok() -> None:
    """The copy names the promotion, says credits now apply, and reassures BYOK."""
    message = promo_exhausted_message("qwen3.8-27b")
    assert "qwen3.8-27b" in message
    assert "credits" in message.lower()
    assert "byok" in message.lower()


def test_apply_promo_exhausted_notice_rewrites_message_and_code_only() -> None:
    """The notice replaces message and code but keeps the insufficient_quota type."""
    body: dict[str, object] = {
        "error": {
            "type": "insufficient_quota",
            "code": "insufficient_quota",
            "message": "monthly gateway allocation is exhausted",
            "param": None,
        }
    }
    rewritten = apply_promo_exhausted_notice(body, "gpt-5.6-luna")
    error = rewritten["error"]
    assert isinstance(error, dict)
    typed = cast("dict[str, object]", error)
    assert typed["code"] == PROMO_CREDITS_NOW_CODE
    assert "gpt-5.6-luna" in cast("str", typed["message"])
    # The HTTP-class type stays a quota condition so official clients still
    # treat it as a 429 quota.
    assert typed["type"] == "insufficient_quota"


def _insert_notice(db: GatewayDatabase, *, org_id: str, label: str, age_seconds: int) -> None:
    """Insert one promotion + its notice row aged ``age_seconds`` in the past.

    v2 notices are promotion-keyed, so the promotion row exists first; the
    label is what the customer-facing lookup returns.
    """
    with db.transaction() as cursor:
        cursor.execute(
            "insert into public.model_promotions "
            "(label, per_org_cap_micro_usd, cap_scope, active) "
            "values (%s, 1000000, 'lifetime', true) returning id",
            (label,),
        )
        row = cursor.fetchone()
        assert row is not None
        cursor.execute(
            "insert into public.model_promotion_notices "
            "(org_id, promotion_id, period_key, notified_at) "
            "values (%s, %s, 'lifetime', clock_timestamp() - make_interval(secs => %s))",
            (org_id, row[0], age_seconds),
        )


@pytest.mark.integration
def test_promo_exhausted_label_returns_fresh_notice_for_key(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A fresh notice row for the key's org yields its promotion label."""
    org_id = gateway_harness.seed_org()
    seeded = gateway_harness.seed_key(org_id=org_id)
    # Committed fixture on a shared database: a per-run label keeps the
    # unique-label constraint happy across reruns without a reset.
    label = f"pv-notice-fresh-{uuid.uuid4().hex[:8]}"
    _insert_notice(gateway_db, org_id=org_id, label=label, age_seconds=1)
    assert promo_exhausted_label_for_key(gateway_db, seeded.raw_key) == label


@pytest.mark.integration
def test_promo_exhausted_label_ignores_stale_notice(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A notice older than the freshness window is not attributed to this refusal."""
    org_id = gateway_harness.seed_org()
    seeded = gateway_harness.seed_key(org_id=org_id)
    _insert_notice(
        gateway_db, org_id=org_id, label=f"pv-notice-stale-{uuid.uuid4().hex[:8]}", age_seconds=120
    )
    assert promo_exhausted_label_for_key(gateway_db, seeded.raw_key) is None


@pytest.mark.integration
def test_promo_exhausted_label_is_none_for_unknown_key(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """An unknown key matches no org, so it never invents a promo notice."""
    unknown = "xpl_" + hashlib.sha256(b"nope").hexdigest()
    assert promo_exhausted_label_for_key(gateway_db, unknown) is None
