# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Customer-facing message for the promo->credits transition (P1030).

A promotional model (``public.model_promotions``) is served free until an org
reaches its per-org cap. The reservation seam (``gateway_start_attempt``) refuses
the FIRST request past the cap with SQLSTATE ``P1030`` so the switch from free to
paid is visible, not silent; the P2 ledger then commits a one-time
``model_promotion_notices`` row (keyed by org, model slug, and period) and raises
a team-scope ``BudgetReservationRejected``.

exp's executor collapses every team-scope refusal to one generic ``429
insufficient_quota`` whose message does not say WHY (the same collapse
:mod:`explabs.gateway.verification_notice` works around for the P1025 gate). exp
is a pinned dependency the platform never edits, so this module restores the
actionable promo message at the explabs serving boundary.

The discriminator mirrors the verify-email one and is cheap and correct: the
message is only ever applied to a response that is ALREADY a 429
insufficient_quota, and only when the key's org has a promo-exhaustion notice row
written in the last few seconds -- i.e. by the very request being refused. That
freshness window is what ties the org-keyed lookup to THIS refusal (the ledger
commits the row before exp produces the 429), and the row carries the model slug
so the message can name it. A stale or absent row yields no rewrite, so an
ordinary balance/budget 429 keeps the generic quota message.

The terminal BYOK-only state (P1031) is deliberately NOT rewritten here: it
writes no notice row (it is not one-time -- it recurs every request until the org
adds credits), and the ASGI response layer does not carry the requested model, so
it surfaces as the clean generic 429 insufficient_quota that requirement 3c asks
for. Its precise reason is carried on the SQL exception for logs and telemetry.
"""

from __future__ import annotations

import hashlib
from typing import cast

from explabs.gateway.db import GatewayDatabase

# Machine-readable code the dashboard/playground and API clients can branch on;
# the HTTP class stays 429 insufficient_quota so official OpenAI and Anthropic
# clients still treat it as a quota condition.
PROMO_CREDITS_NOW_CODE = "promo_credits_now"

# Seconds within which a promo-exhaustion notice row is attributed to the current
# refusal. The ledger writes the row synchronously during this request before exp
# emits the 429, so a few seconds comfortably covers the round trip while keeping
# a later unrelated 429 from inheriting the promo message.
_NOTICE_FRESHNESS_SECONDS = 15


def promo_exhausted_message(promo_label: str) -> str:
    """Return the verbose promo->credits transition message for ``promo_label``.

    The label is the promotion's operator-facing name; for a single-model
    promotion it is conventionally the model slug, so the message reads the
    same as v1's per-model form.
    """
    return (
        f"Your free promo for {promo_label} is used up. Further requests to "
        "these models now draw your organization's platform credits -- retry "
        "to continue. Requests using your own provider keys (BYOK) are "
        "unaffected."
    )


def promo_exhausted_label_for_key(db: GatewayDatabase, raw_key: str) -> str | None:
    """Return the just-exhausted promotion's label for ``raw_key``'s org, if any.

    Reads the most recent ``model_promotion_notices`` row for the org that owns
    the presented key, within the freshness window, so the notice is attributed
    to the current refusal; joins ``model_promotions`` for the operator-facing
    label (v2 notices are promotion-keyed — a scoped promotion spans models).
    Keyed by the key's SHA-256 (the hash ``api_keys.key_hash`` stores),
    mirroring the verify-email lookup.

    Args:
        db: Shared worker connection pool.
        raw_key: The presented gateway key, verbatim from the request.

    Returns:
        The label of the promotion whose free allowance was just exhausted for
        this org, or ``None`` when there is no fresh notice (so no rewrite
        happens). Any lookup failure returns ``None`` so a hiccup never invents
        a notice.
    """
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    try:
        with db.transaction() as cursor:
            cursor.execute(
                """
                select promotions.label
                  from public.model_promotion_notices notices
                  join public.model_promotions promotions
                    on promotions.id = notices.promotion_id
                  join public.api_keys keys on keys.org_id = notices.org_id
                 where keys.key_hash = %s
                   and notices.notified_at
                     >= clock_timestamp() - make_interval(secs => %s)
                 order by notices.notified_at desc
                 limit 1
                """,
                (key_hash, _NOTICE_FRESHNESS_SECONDS),
            )
            row = cursor.fetchone()
    except Exception:  # noqa: BLE001 - a notice is best-effort; never fail a response
        return None
    return None if row is None else cast("str", row[0])


def apply_promo_exhausted_notice(body: dict[str, object], promo_label: str) -> dict[str, object]:
    """Rewrite an insufficient-quota envelope to the promo->credits message.

    Mutates and returns the envelope in place: the HTTP status and error ``type``
    stay ``insufficient_quota``; only the human ``message`` and machine ``code``
    change so a client can tell the promo switch from a balance exhaustion.
    """
    error = body.get("error")
    if isinstance(error, dict):
        typed = cast("dict[str, object]", error)
        typed["message"] = promo_exhausted_message(promo_label)
        typed["code"] = PROMO_CREDITS_NOW_CODE
    return body
