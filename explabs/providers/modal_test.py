# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Modal probe verdicts around the SDK handshake seam."""

from __future__ import annotations

import json

from modal.exception import AuthError

from explabs.db.stores.provider_connection_store import ConnectionStatus
from explabs.db.stores.provider_snapshot_store import SnapshotSource
from explabs.providers import modal
from explabs.providers.modal import ModalTokenPair
from explabs.providers.spend import SpendReportKind

PAIR_SECRET = json.dumps({"token_id": "ak-test-id", "token_secret": "as-test-secret"})


def test_a_working_token_pair_is_valid() -> None:
    """A handshake that returns without raising proves the pair."""
    seen: list[ModalTokenPair] = []
    result = modal.probe(PAIR_SECRET, verifier=seen.append)
    assert result.status is ConnectionStatus.VALID
    assert seen[0].token_id == "ak-test-id"
    assert seen[0].token_secret == "as-test-secret"


def test_rejected_tokens_are_invalid_with_the_token_id_named() -> None:
    """AuthError from the handshake means the pair itself."""

    def reject(_pair: ModalTokenPair) -> None:
        msg = "Token authentication failed"
        raise AuthError(msg)

    result = modal.probe(PAIR_SECRET, verifier=reject)
    assert result.status is ConnectionStatus.INVALID
    assert result.detail.provider_code == "AuthError"
    assert "ak-test-id" in result.detail.remediation
    # The secret half must never surface.
    assert "as-test-secret" not in result.model_dump_json()


def test_a_stored_secret_that_is_not_a_pair_is_invalid_without_a_call() -> None:
    """Malformed Vault JSON and wrong prefixes classify before any handshake."""

    def fail(_pair: ModalTokenPair) -> None:
        msg = "a malformed pair must not reach the handshake"
        raise AssertionError(msg)

    for secret in (
        "not-json-at-all",
        json.dumps({"token_id": "ak-only-half"}),
        json.dumps({"token_id": "wrong-prefix", "token_secret": "as-x"}),
        json.dumps({"token_id": "ak-x", "token_secret": "wrong-prefix"}),
    ):
        result = modal.probe(secret, verifier=fail)
        assert result.status is ConnectionStatus.INVALID
        assert result.detail.provider_code == "malformed_token_pair"
        assert "token id (ak-…)" in result.detail.remediation


def test_an_unreachable_modal_is_provider_error() -> None:
    """Transport failures mean our check failed, not their tokens."""

    def unreachable(_pair: ModalTokenPair) -> None:
        msg = "grpc channel closed"
        raise ConnectionError(msg)

    result = modal.probe(PAIR_SECRET, verifier=unreachable)
    assert result.status is ConnectionStatus.PROVIDER_ERROR
    assert result.detail.provider_code == "ConnectionError"


def test_spend_reports_metered_cost_and_credits_applied() -> None:
    """Live shape (SDK summary): metered cost plus credit adjustments, no balance."""
    cycle = modal.WorkspaceBillingCycle(
        metered_cost_usd=2179.95781354,
        billed_cost_usd=0.0,
        metered_cost_breakdown_usd={"Deployed Apps": 2157.13324641, "Volumes": 22.82781354},
        adjustments_usd={"Credits": -2157.13, "Free Storage": -22.82781354, "Plan Cost": 0.0},
    )
    report = modal.spend(
        json.dumps({"token_id": "ak-id-1234", "token_secret": "as-secret-5678"}),
        summary_reader=lambda _pair: cycle,
    )
    assert report.kind is SpendReportKind.REPORTED
    assert report.source is SnapshotSource.PROVIDER_API
    assert report.spend_usd == 2179.95781354
    assert report.credits_remaining_usd is None
    assert report.detail is not None
    assert report.detail["credits_applied_usd"] == round(2157.13 + 22.82781354, 6)
    assert "remaining balance" in report.message


def test_spend_on_a_malformed_stored_pair_fails_loudly() -> None:
    """A stored secret that is not a token pair is a read failure with the fix."""
    report = modal.spend("not-json")
    assert report.kind is SpendReportKind.READ_FAILED
    assert "token id" in report.message


def test_spend_read_failure_when_the_sdk_raises() -> None:
    """SDK/transport failures keep the stored numbers."""

    def boom(_pair: ModalTokenPair) -> modal.WorkspaceBillingCycle:
        msg = "grpc unavailable"
        raise RuntimeError(msg)

    report = modal.spend(
        json.dumps({"token_id": "ak-id-1234", "token_secret": "as-secret-5678"}),
        summary_reader=boom,
    )
    assert report.kind is SpendReportKind.READ_FAILED
    assert "RuntimeError" in report.message
