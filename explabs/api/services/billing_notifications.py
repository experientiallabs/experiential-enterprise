# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Best-effort Slack pings for billing events.

One incoming-webhook POST per event, gated on ``SLACK_BILLING_WEBHOOK_URL``:
unset means no-op (local, CI, previews without the manual secret step). A
notification must never fail or slow the customer-facing write it follows —
every failure path degrades to a warning log.
"""

from __future__ import annotations

import logging
import os

import httpx

from explabs.db.stores.yc_claim_store import YC_GRANT_USD

logger = logging.getLogger(__name__)

SLACK_WEBHOOK_ENV = "SLACK_BILLING_WEBHOOK_URL"
_TIMEOUT_SECONDS = 3.0


def notify_yc_claim(*, org_name: str, org_slug: str, user_email: str | None, org_id: str) -> bool:
    """Announce one /yc grant claim on the billing Slack channel.

    Args:
        org_name: Claiming organization's display name.
        org_slug: Claiming organization's slug.
        user_email: Claiming member's email, when the auth row carries one.
        org_id: Organization UUID, spelled into the revoke instructions.

    Returns:
        ``True`` when Slack accepted the message; ``False`` on no-op or
        failure (already logged) — callers never branch on delivery.
    """
    text = (
        f"YC claim: {org_name} ({org_slug}) by {user_email or 'unknown email'} — "
        f"${YC_GRANT_USD:.0f}. "
        "Revoke: negative admin adjustment in the admin Orgs panel (OrgsPanel) "
        f"or POST /api/admin/orgs/{org_id}/credit-grants with a negative amount."
    )
    return post_billing_message(text)


def post_billing_message(text: str) -> bool:
    """POST one plain-text message to the billing webhook, best effort."""
    webhook_url = os.environ.get(SLACK_WEBHOOK_ENV, "").strip()
    if not webhook_url:
        return False
    try:
        response = httpx.post(webhook_url, json={"text": text}, timeout=_TIMEOUT_SECONDS)
    except httpx.HTTPError:
        logger.warning("Slack billing notification failed", exc_info=True)
        return False
    if response.status_code >= 400:
        logger.warning("Slack billing notification refused: HTTP %s", response.status_code)
        return False
    return True
