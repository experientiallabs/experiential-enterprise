# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Modal token verification: the SDK's authentication handshake.

Modal has no key-validation REST endpoint; the SDK's client handshake is the
cheapest authenticated call. The credential is the token pair — token_id
(``ak-…``) plus token_secret (``as-…``) — stored as one JSON Vault secret.
"""

from __future__ import annotations

import json
from collections.abc import Callable

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from explabs.db.stores.provider_connection_store import ConnectionStatus
from explabs.db.stores.provider_snapshot_store import SnapshotSource
from explabs.providers.accounts import ProbeDetail, ProbeResult
from explabs.providers.spend import SpendReport, SpendReportKind


class ModalTokenPair(BaseModel):
    """The two halves of a Modal token, as stored in the one Vault secret."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    token_id: str = Field(pattern=r"^ak-\S+$")
    token_secret: str = Field(pattern=r"^as-\S+$")


def _default_verifier(pair: ModalTokenPair) -> None:
    """The real SDK handshake; raises ``modal.exception.AuthError`` on bad tokens."""
    # Imported lazily: the Modal SDK is heavy and only this call needs it.
    from modal.client import Client
    from modal.config import config

    # The SDK config may list failover server URLs comma-separated; the
    # handshake needs exactly one.
    server_url = str(config["server_url"]).split(",")[0]
    Client.verify(server_url, (pair.token_id, pair.token_secret))


def probe(
    credential: str,
    *,
    verifier: Callable[[ModalTokenPair], None] = _default_verifier,
) -> ProbeResult:
    """Verify one stored Modal token pair via the SDK handshake."""
    pair = _parse_pair(credential)
    if isinstance(pair, ProbeResult):
        return pair
    from modal.exception import AuthError

    try:
        verifier(pair)
    except AuthError as error:
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_code=type(error).__name__,
                provider_message=str(error) or None,
                remediation=(
                    f"Modal rejected the token pair with id {pair.token_id}. Create a "
                    "fresh token at modal.com → Settings → API tokens and paste both the "
                    "token id (ak-…) and token secret (as-…) again — a revoked or "
                    "regenerated token invalidates the old secret."
                ),
            ),
        )
    except Exception as error:  # noqa: BLE001 - the SDK raises transport-specific errors
        return ProbeResult(
            status=ConnectionStatus.PROVIDER_ERROR,
            detail=ProbeDetail(
                provider_code=type(error).__name__,
                provider_message=str(error) or None,
                remediation=(
                    f"Modal could not be reached to verify the token pair "
                    f"({type(error).__name__}). The tokens are saved but unverified; this "
                    "was our check failing, not your tokens. Real traffic will verify "
                    "them, or rotate the pair to re-run the check."
                ),
            ),
        )
    return ProbeResult(
        status=ConnectionStatus.VALID,
        detail=ProbeDetail(
            remediation="The Modal token pair works: the SDK handshake authenticated.",
        ),
    )


def _parse_pair(credential: str) -> ModalTokenPair | ProbeResult:
    """The stored JSON secret as a typed pair, or the invalid verdict."""
    try:
        payload = json.loads(credential)
        return ModalTokenPair.model_validate(payload)
    except (ValueError, ValidationError):
        return ProbeResult(
            status=ConnectionStatus.INVALID,
            detail=ProbeDetail(
                provider_code="malformed_token_pair",
                remediation=(
                    "The stored Modal credential is not a token pair. Reconnect Modal with "
                    "both halves from modal.com → Settings → API tokens: the token id "
                    "(ak-…) and the token secret (as-…)."
                ),
            ),
        )


class WorkspaceBillingCycle(BaseModel):
    """The slice of Modal's billing summary the spend read uses.

    Mirrors the SDK's ``WorkspaceBillingSummary`` dataclass with plain floats,
    so tests fake the seam without importing the SDK.
    """

    model_config = ConfigDict(frozen=True)

    metered_cost_usd: float
    billed_cost_usd: float
    # Cost by resource kind ("Deployed Apps", "Volumes", …).
    metered_cost_breakdown_usd: dict[str, float]
    # Credits and other reductions applied this cycle (negative values).
    adjustments_usd: dict[str, float]


def _default_summary(pair: ModalTokenPair) -> WorkspaceBillingCycle:
    """The real SDK read: this billing cycle's workspace summary."""
    # Imported lazily: the Modal SDK is heavy and only this call needs it.
    import modal
    from modal.client import Client

    client = Client.from_credentials(pair.token_id, pair.token_secret)
    summary = modal.Workspace.from_context(client=client).billing.summary()
    return WorkspaceBillingCycle(
        metered_cost_usd=float(summary.metered_cost),
        billed_cost_usd=float(summary.billed_cost),
        metered_cost_breakdown_usd={
            name: float(value) for name, value in summary.metered_cost_breakdown.items()
        },
        adjustments_usd={name: float(value) for name, value in summary.adjustments.items()},
    )


def spend(
    credential: str,
    *,
    summary_reader: Callable[[ModalTokenPair], WorkspaceBillingCycle] = _default_summary,
) -> SpendReport:
    """Read one Modal workspace's current-cycle cost.

    Live-tested 2026-08-19: Modal has no public REST billing API — the SDK's
    ``Workspace.billing.summary()`` is the read. It reports metered cost and
    the credits APPLIED this cycle, not a remaining balance, so credits
    remaining is never reported.
    """
    pair = _parse_pair(credential)
    if isinstance(pair, ProbeResult):
        return SpendReport(kind=SpendReportKind.READ_FAILED, message=pair.detail.remediation)
    try:
        cycle = summary_reader(pair)
    except Exception as error:  # noqa: BLE001 - the SDK raises transport-specific errors
        return SpendReport(
            kind=SpendReportKind.READ_FAILED,
            detail={"provider_code": type(error).__name__, "provider_message": str(error) or None},
            message=(
                f"Modal could not be read for billing ({type(error).__name__}). "
                "The stored numbers are unchanged; try again later."
            ),
        )
    credits_applied = -sum(value for value in cycle.adjustments_usd.values() if value < 0)
    return SpendReport(
        kind=SpendReportKind.REPORTED,
        source=SnapshotSource.PROVIDER_API,
        spend_usd=cycle.metered_cost_usd,
        detail={
            "billed_cost_usd": round(cycle.billed_cost_usd, 6),
            "credits_applied_usd": round(credits_applied, 6),
            "metered_cost_breakdown_usd": {
                name: round(value, 6) for name, value in cycle.metered_cost_breakdown_usd.items()
            },
            "adjustments_usd": {
                name: round(value, 6) for name, value in cycle.adjustments_usd.items()
            },
        },
        message=(
            "Modal reports this billing cycle's metered cost and the credits "
            "applied to it, not a remaining balance; use the self-reported "
            "gauge for remaining credit."
        ),
    )
