# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Tests for the pluggable balance-fetcher seam (deterministic + computer-use)."""

from __future__ import annotations

from collections.abc import Callable

import httpx

from explabs.db.stores.tool_account_store import BalanceSource, TrackedToolVendor
from explabs.providers.balance_fetch import (
    BalanceFetchKind,
    BalanceFetchStrategy,
    BalanceReading,
    ComputerUseBalanceFetcher,
    DeterministicBalanceFetcher,
    build_tool_fetcher,
    cursor_balance,
)


def _transport(
    handler: Callable[[httpx.Request], httpx.Response],
) -> httpx.MockTransport:
    """A MockTransport around a request handler."""
    return httpx.MockTransport(handler)


def test_deterministic_fetcher_returns_the_wrapped_read() -> None:
    """The deterministic strategy is a thin wrapper over a vendor-API read."""
    reading = BalanceReading(
        kind=BalanceFetchKind.REPORTED,
        strategy=BalanceFetchStrategy.DETERMINISTIC,
        balance_usd=12.0,
        source=BalanceSource.VENDOR_API,
        message="mocked",
    )
    fetcher = DeterministicBalanceFetcher(read=lambda: reading)
    assert fetcher.strategy is BalanceFetchStrategy.DETERMINISTIC
    assert fetcher.fetch() is reading


def test_computer_use_path_is_selected_for_api_less_vendors() -> None:
    """E2B, Greptile, and Devin have no billing API, so they route to the agent."""
    for vendor in (TrackedToolVendor.E2B, TrackedToolVendor.GREPTILE, TrackedToolVendor.DEVIN):
        fetcher = build_tool_fetcher(vendor, credential=None, config={})
        assert isinstance(fetcher, ComputerUseBalanceFetcher)
        assert fetcher.strategy is BalanceFetchStrategy.COMPUTER_USE
        # The stubbed agent never receives a credential.
        assert fetcher.credential is None
        reading = fetcher.fetch()
        assert reading.kind is BalanceFetchKind.PENDING
        assert reading.balance_usd is None


def test_cursor_routes_to_the_deterministic_strategy() -> None:
    """Cursor's Admin API makes it the one deterministic tool vendor."""
    fetcher = build_tool_fetcher(
        TrackedToolVendor.CURSOR, credential="cur-admin-key-1234", config={}
    )
    assert isinstance(fetcher, DeterministicBalanceFetcher)
    assert fetcher.strategy is BalanceFetchStrategy.DETERMINISTIC


def test_cursor_balance_reports_remaining_budget() -> None:
    """Remaining = summed per-user limits minus summed on-demand spend."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/teams/spend"
        return httpx.Response(
            200,
            json={
                "teamMemberSpend": [
                    {"spendCents": 2500, "effectivePerUserLimitDollars": 100},
                    {"spendCents": 1000, "effectivePerUserLimitDollars": 50},
                ],
                "totalPages": 1,
            },
        )

    reading = cursor_balance("cur-admin-key-1234", transport=_transport(handler))
    assert reading.kind is BalanceFetchKind.REPORTED
    assert reading.source is BalanceSource.VENDOR_API
    # (100 + 50) limit - (25 + 10) spend = 115 remaining.
    assert reading.balance_usd == 115.0


def test_cursor_balance_without_a_credential_is_not_reportable() -> None:
    """No stored Admin key means the honest connect-a-key state."""
    reading = cursor_balance(None)
    assert reading.kind is BalanceFetchKind.NOT_REPORTABLE
    assert reading.balance_usd is None


def test_cursor_balance_without_limits_is_not_reportable() -> None:
    """Spend with no configured limit has no budget to compute remaining from."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "teamMemberSpend": [{"spendCents": 4200, "effectivePerUserLimitDollars": None}],
                "totalPages": 1,
            },
        )

    reading = cursor_balance("cur-admin-key-1234", transport=_transport(handler))
    assert reading.kind is BalanceFetchKind.NOT_REPORTABLE


def test_cursor_balance_surfaces_a_failed_read() -> None:
    """A non-2xx Admin API answer is a read failure, not a balance."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": {"message": "bad key"}})

    reading = cursor_balance("cur-admin-key-1234", transport=_transport(handler))
    assert reading.kind is BalanceFetchKind.READ_FAILED
