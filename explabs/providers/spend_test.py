# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The spend contract: floors cover every provider, dispatch routes secrets."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from explabs.db.stores.provider_connection_store import (
    ConnectableProvider,
    ProviderConnectionRecord,
)
from explabs.providers import spend
from explabs.providers.spend import SpendReportKind


def _record(
    provider: ConnectableProvider, config: dict[str, object] | None = None
) -> ProviderConnectionRecord:
    return ProviderConnectionRecord(
        id="conn-1", org_id="org-1", provider=provider, config=config or {}
    )


def test_every_provider_has_a_staleness_floor() -> None:
    """A provider without a floor would make the refresh endpoint crash."""
    assert set(spend.SPEND_REFRESH_FLOOR_SECONDS) == set(ConnectableProvider)


def test_bedrock_floor_is_hours_and_key_providers_minutes() -> None:
    """Cost Explorer bills $0.01 per query; the floor is the cost control."""
    assert spend.SPEND_REFRESH_FLOOR_SECONDS[ConnectableProvider.BEDROCK] == 3 * 60 * 60
    for provider in (
        ConnectableProvider.OPENROUTER,
        ConnectableProvider.ANTHROPIC,
        ConnectableProvider.OPENAI,
        ConnectableProvider.FIREWORKS,
        ConnectableProvider.MODAL,
    ):
        assert spend.SPEND_REFRESH_FLOOR_SECONDS[provider] == 5 * 60


def test_month_to_date_start_is_the_utc_month_boundary() -> None:
    """Every adapter reads the same month-to-date window."""
    moment = datetime(2026, 8, 19, 15, 30, tzinfo=UTC)
    assert spend.month_to_date_start(moment) == datetime(2026, 8, 1, tzinfo=UTC)


def test_dispatch_routes_the_admin_key_to_anthropic() -> None:
    """Anthropic reads spend with the ADMIN credential, never the main key."""
    report = spend.read_spend(
        _record(ConnectableProvider.ANTHROPIC), credential="sk-ant-api03-x", spend_credential=None
    )
    assert report.kind is SpendReportKind.NOT_REPORTABLE
    assert "admin key" in report.message


def test_dispatch_answers_never_reportable_providers_without_credentials() -> None:
    """Gemini and Azure never query anything, so no secret is needed at all."""
    for provider in (ConnectableProvider.GEMINI, ConnectableProvider.AZURE_OPENAI):
        report = spend.read_spend(_record(provider), credential=None, spend_credential=None)
        assert report.kind is SpendReportKind.NOT_REPORTABLE


def test_dispatch_requires_the_main_credential_where_the_key_reads_billing() -> None:
    """A missing main secret on an openrouter read is a caller bug, said loudly."""
    with pytest.raises(ValueError, match="released main credential"):
        spend.read_spend(
            _record(ConnectableProvider.OPENROUTER), credential=None, spend_credential=None
        )
