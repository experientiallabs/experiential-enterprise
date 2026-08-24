# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""The pluggable balance-fetcher seam for accounts without a key-based spend API.

Some accounts a team funds expose no programmatic way to read a remaining
credit balance with the credential we hold: the API-less tool accounts (E2B,
Greptile, Devin) and, among model providers, Azure and Gemini. This module is
the seam that answers "what is left on this account right now?" for them, with
two interchangeable strategies behind one ``BalanceFetcher`` protocol:

- ``DETERMINISTIC`` — the vendor exposes a billing API we can read with a stored
  credential. Cursor's Admin API (``POST /teams/spend``) is the one tool vendor
  with such an API today, so Cursor is the deterministic strategy's production
  consumer.
- ``COMPUTER_USE`` — no such API exists, so a computer-use agent logs into the
  vendor dashboard and reads the remaining balance off the page. The dashboard
  login is a Vault secret released only at fetch time.

Every fetch yields a typed ``BalanceReading`` (never raises for a vendor-side
condition): ``REPORTED`` (a figure rode back), ``NOT_REPORTABLE`` (there is
honestly nothing to read), ``READ_FAILED`` (the read should have worked but did
not), or ``PENDING`` (the computer-use path is wired but not yet enabled).

Computer-use workflow (design; the execution is STUBBED in this change)
----------------------------------------------------------------------
When enabled, ``ComputerUseBalanceFetcher.fetch`` will:

1. Release the vendor's dashboard-login Vault secret (never before this point,
   never logged, never serialized to any view).
2. Start an E2B sandbox (``from e2b import Sandbox``; ``E2B_API_KEY`` from env,
   the same substrate the storage-cleanup path already uses) with a headless
   browser, or drive Anthropic computer-use against a hosted browser.
3. Navigate to the vendor's billing page (``DASHBOARD_URLS``), log in with the
   released credential, read the remaining-credit figure, and parse it to USD.
4. Tear the sandbox down (claim-fenced per AGENTS rule 24) and return a
   ``REPORTED`` reading sourced ``COMPUTER_USE`` — or ``READ_FAILED`` with the
   page state when the figure could not be read.

It is stubbed here because storing and replaying third-party dashboard
passwords, and giving an autonomous agent a logged-in browser session, is a
credential-handling model that needs product sign-off before it ships. The
typed seam, the Vault storage, the per-account "Fetch balance" action, and the
scheduled runner are all real; only the browser step returns ``PENDING`` until
the model is signed off. The credential is deliberately NOT released on the
stubbed path, so no dashboard secret ever leaves Vault before the agent exists.

TODO(balance-fetch): implement the E2B/computer-use browser step above once the
credential-release + autonomous-session security model is signed off.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import ClassVar, Protocol, runtime_checkable

import httpx
from pydantic import BaseModel, ConfigDict

from explabs.db.repositories import JsonObject
from explabs.db.stores.tool_account_store import BalanceSource, TrackedToolVendor
from explabs.providers.accounts import probe_client, response_message


class BalanceFetchStrategy(StrEnum):
    """How an account's remaining balance is read."""

    # A vendor billing API read with a stored credential (no browser).
    DETERMINISTIC = "deterministic"
    # A computer-use agent that logs into the vendor dashboard and reads it.
    COMPUTER_USE = "computer_use"


class BalanceFetchKind(StrEnum):
    """The four honest outcomes of one balance fetch."""

    REPORTED = "reported"
    NOT_REPORTABLE = "not_reportable"
    READ_FAILED = "read_failed"
    # The computer-use path is wired but not yet enabled for this vendor.
    PENDING = "pending"


class BalanceReading(BaseModel):
    """One account's remaining-balance reading, or the reason there is none."""

    model_config = ConfigDict(frozen=True)

    kind: BalanceFetchKind
    strategy: BalanceFetchStrategy
    # Set exactly when kind is REPORTED: remaining credit in USD.
    balance_usd: float | None = None
    # Set exactly when kind is REPORTED: which lane produced the figure.
    source: BalanceSource | None = None
    # Always present: the customer-facing sentence for this reading.
    message: str


@runtime_checkable
class BalanceFetcher(Protocol):
    """One account's balance reader; the seam every strategy implements."""

    strategy: BalanceFetchStrategy

    def fetch(self) -> BalanceReading:
        """Read the account's remaining balance, or the reason there is none."""
        ...


@dataclass(frozen=True)
class DeterministicBalanceFetcher:
    """Wraps a vendor billing-API read that returns a remaining balance.

    The read callable owns the HTTP work and returns a ``BalanceReading``; this
    fetcher exists so the dispatch and the scheduled runner treat a deterministic
    read and a computer-use read through one protocol.
    """

    read: Callable[[], BalanceReading]
    strategy: ClassVar[BalanceFetchStrategy] = BalanceFetchStrategy.DETERMINISTIC

    def fetch(self) -> BalanceReading:
        """Run the wrapped vendor billing-API read."""
        return self.read()


@dataclass(frozen=True)
class ComputerUseBalanceFetcher:
    """Reads a vendor's remaining balance by driving its dashboard with an agent.

    STUBBED: ``fetch`` returns a ``PENDING`` reading and never releases a
    credential or touches E2B, until the computer-use security model is signed
    off (see the module docstring for the full workflow and TODO). The
    ``credential`` field is typed for the real path but must be ``None`` here so
    no dashboard secret is released before the agent exists.
    """

    vendor_label: str
    dashboard_url: str
    config: JsonObject
    credential: str | None = None
    strategy: ClassVar[BalanceFetchStrategy] = BalanceFetchStrategy.COMPUTER_USE

    def fetch(self) -> BalanceReading:
        """Return the pending state; the browser step is not yet enabled."""
        return BalanceReading(
            kind=BalanceFetchKind.PENDING,
            strategy=BalanceFetchStrategy.COMPUTER_USE,
            message=(
                f"{self.vendor_label} exposes no balance API, so its balance is read by a "
                "computer-use agent from the vendor dashboard. That fetcher is not yet "
                "enabled (pending sign-off on the credential-handling model). Use the "
                "self-reported gauge to track remaining credit for now."
            ),
        )


# Which strategy reads each tool vendor's balance. Only Cursor has a billing API
# we can read with a stored credential; the rest need the dashboard agent.
TOOL_VENDOR_STRATEGY: dict[TrackedToolVendor, BalanceFetchStrategy] = {
    TrackedToolVendor.CURSOR: BalanceFetchStrategy.DETERMINISTIC,
    TrackedToolVendor.E2B: BalanceFetchStrategy.COMPUTER_USE,
    TrackedToolVendor.GREPTILE: BalanceFetchStrategy.COMPUTER_USE,
    TrackedToolVendor.DEVIN: BalanceFetchStrategy.COMPUTER_USE,
}

# The billing page a computer-use fetch would read (also the customer-facing
# "where this number comes from" link).
DASHBOARD_URLS: dict[TrackedToolVendor, str] = {
    TrackedToolVendor.E2B: "https://console.e2b.dev/?tab=usage",
    TrackedToolVendor.GREPTILE: "https://app.greptile.com/settings/billing",
    TrackedToolVendor.DEVIN: "https://app.devin.ai/settings/billing",
    TrackedToolVendor.CURSOR: "https://cursor.com/dashboard?tab=billing",
}

_VENDOR_LABELS: dict[TrackedToolVendor, str] = {
    TrackedToolVendor.E2B: "E2B",
    TrackedToolVendor.GREPTILE: "Greptile",
    TrackedToolVendor.CURSOR: "Cursor",
    TrackedToolVendor.DEVIN: "Devin",
}


def build_tool_fetcher(
    vendor: TrackedToolVendor,
    *,
    credential: str | None,
    config: JsonObject,
    transport: httpx.BaseTransport | None = None,
) -> BalanceFetcher:
    """The fetcher for one tool vendor, given its released credential (if any).

    Args:
        vendor: The tool vendor to read.
        credential: The released credential for a deterministic read (Cursor's
            Admin API key); ``None`` for the computer-use vendors, whose secret
            is deliberately not released on the stubbed path.
        config: The account's non-secret config (e.g. Cursor team id).
        transport: Optional httpx transport override for tests.

    Returns:
        A ``BalanceFetcher`` for the vendor's strategy.
    """
    label = _VENDOR_LABELS[vendor]
    match TOOL_VENDOR_STRATEGY[vendor]:
        case BalanceFetchStrategy.DETERMINISTIC:
            return DeterministicBalanceFetcher(
                read=lambda: cursor_balance(credential, transport=transport)
            )
        case BalanceFetchStrategy.COMPUTER_USE:
            return ComputerUseBalanceFetcher(
                vendor_label=label,
                dashboard_url=DASHBOARD_URLS[vendor],
                config=config,
                credential=None,
            )


_CURSOR_SPEND_URL = "https://api.cursor.com/teams/spend"
# A month of team members fits well inside this page bound; the guard keeps a
# vendor bug from looping.
_CURSOR_PAGE_BOUND = 50
_CURSOR_PAGE_SIZE = 100


def cursor_balance(
    credential: str | None, *, transport: httpx.BaseTransport | None = None
) -> BalanceReading:
    """Read a Cursor team's remaining on-demand budget via the Admin API.

    Cursor's ``POST /teams/spend`` reports per-member on-demand ``spendCents``
    and the enforced ``effectivePerUserLimitDollars`` for the current cycle
    (Basic auth, the Admin API key as the username). Remaining = the summed
    per-user limits minus the summed spend, floored at zero. When no member has
    a limit configured there is no budget to compute remaining from, so the read
    is ``NOT_REPORTABLE`` and names the current spend instead.

    Args:
        credential: The Cursor Admin API key (Vault-released). ``None`` yields
            the honest connect-a-key state.
        transport: Optional httpx transport override for tests.

    Returns:
        The team's remaining on-demand budget, or the honest reason there is
        none.
    """
    if credential is None:
        return BalanceReading(
            kind=BalanceFetchKind.NOT_REPORTABLE,
            strategy=BalanceFetchStrategy.DETERMINISTIC,
            message=(
                "Cursor's balance is read from the Admin API, which needs the team's "
                "Cursor Admin API key. Add it to this account to fetch the balance, or use "
                "the self-reported gauge."
            ),
        )
    total_spend_usd = 0.0
    total_limit_usd = 0.0
    saw_limit = False
    try:
        with probe_client(transport) as client:
            for page in range(1, _CURSOR_PAGE_BOUND + 1):
                response = client.post(
                    _CURSOR_SPEND_URL,
                    auth=(credential, ""),
                    json={"page": page, "pageSize": _CURSOR_PAGE_SIZE},
                )
                if not response.is_success:
                    return _cursor_read_failed(response)
                payload = response.json()
                members = payload.get("teamMemberSpend")
                for raw in members if isinstance(members, list) else []:
                    if not isinstance(raw, dict):
                        continue
                    total_spend_usd += _as_float(raw.get("spendCents")) / 100.0
                    limit = _as_float(raw.get("effectivePerUserLimitDollars"))
                    if limit > 0:
                        saw_limit = True
                        total_limit_usd += limit
                total_pages = raw_int(payload.get("totalPages"))
                if total_pages is None or page >= total_pages:
                    break
    except httpx.HTTPError as error:
        return BalanceReading(
            kind=BalanceFetchKind.READ_FAILED,
            strategy=BalanceFetchStrategy.DETERMINISTIC,
            message=(
                f"Cursor could not be reached to read the team balance ({type(error).__name__}). "
                "The stored balance is unchanged; try again later."
            ),
        )

    if not saw_limit:
        return BalanceReading(
            kind=BalanceFetchKind.NOT_REPORTABLE,
            strategy=BalanceFetchStrategy.DETERMINISTIC,
            message=(
                f"Cursor reports ${total_spend_usd:.2f} of on-demand spend this cycle but no "
                "per-user limit is set, so there is no budget to compute a remaining balance "
                "from. Set a team spend limit in Cursor, or use the self-reported gauge."
            ),
        )
    remaining = max(0.0, total_limit_usd - total_spend_usd)
    return BalanceReading(
        kind=BalanceFetchKind.REPORTED,
        strategy=BalanceFetchStrategy.DETERMINISTIC,
        balance_usd=remaining,
        source=BalanceSource.VENDOR_API,
        message=(
            f"Cursor: ${remaining:.2f} of on-demand budget left this cycle "
            f"(${total_spend_usd:.2f} spent of ${total_limit_usd:.2f} limit)."
        ),
    )


def _cursor_read_failed(response: httpx.Response) -> BalanceReading:
    """A failed Cursor Admin API read, carrying Cursor's own words."""
    message = response_message(response)
    said = f" It said: {message}" if message else ""
    return BalanceReading(
        kind=BalanceFetchKind.READ_FAILED,
        strategy=BalanceFetchStrategy.DETERMINISTIC,
        message=(
            f"Cursor refused the balance read (HTTP {response.status_code}).{said} Check the "
            "team's Cursor Admin API key. The stored balance is unchanged."
        ),
    )


def _as_float(value: object) -> float:
    """A JSON number (Cursor sends fractional cents) as float; 0.0 otherwise."""
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return 0.0
    return 0.0


def raw_int(value: object) -> int | None:
    """A JSON integer as int, or None when the field is absent or not numeric."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None
