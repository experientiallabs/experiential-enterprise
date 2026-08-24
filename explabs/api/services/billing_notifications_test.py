# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the best-effort billing Slack notifier."""

from __future__ import annotations

import pytest

from explabs.api.services import billing_notifications
from explabs.api.services.billing_notifications import notify_yc_claim, post_billing_message


def test_unset_webhook_is_a_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    """Local, CI, and previews without the secret never attempt a POST."""
    monkeypatch.delenv(billing_notifications.SLACK_WEBHOOK_ENV, raising=False)

    def unexpected_post(*args: object, **kwargs: object) -> object:
        msg = "no webhook configured, nothing may be POSTed"
        raise AssertionError(msg)

    monkeypatch.setattr(billing_notifications.httpx, "post", unexpected_post)

    assert post_billing_message("hello") is False


def test_claim_message_names_org_user_and_revoke_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ping carries enough to act on: who claimed, and how to revoke."""
    monkeypatch.setenv(billing_notifications.SLACK_WEBHOOK_ENV, "https://hooks.example/x")
    sent: list[str] = []

    def fake_post(url: str, *, json: dict[str, str], timeout: float) -> object:
        _ = url, timeout
        sent.append(json["text"])

        class _Response:
            status_code = 200

        return _Response()

    monkeypatch.setattr(billing_notifications.httpx, "post", fake_post)

    delivered = notify_yc_claim(
        org_name="YC Tenant", org_slug="yc-tenant", user_email=None, org_id="org-yc"
    )

    assert delivered is True
    assert sent == [
        "YC claim: YC Tenant (yc-tenant) by unknown email — $526. "
        "Revoke: negative admin adjustment in the admin Orgs panel (OrgsPanel) "
        "or POST /api/admin/orgs/org-yc/credit-grants with a negative amount."
    ]


def test_slack_refusal_degrades_to_false(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 4xx/5xx from Slack is logged and swallowed, never raised."""
    monkeypatch.setenv(billing_notifications.SLACK_WEBHOOK_ENV, "https://hooks.example/x")

    def refusing_post(url: str, *, json: dict[str, str], timeout: float) -> object:
        _ = url, json, timeout

        class _Response:
            status_code = 410

        return _Response()

    monkeypatch.setattr(billing_notifications.httpx, "post", refusing_post)

    assert post_billing_message("hello") is False
