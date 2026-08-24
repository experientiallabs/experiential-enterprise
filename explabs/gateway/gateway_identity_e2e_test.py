# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""End-to-end identity-tier proof against the P-B/P-C enforcement in real PG.

This is the P-D demo the plan asks for, exercised through the SAME rows the
management API writes: create an identity, issue a key under it, grant it one
alias, and cap it with a monthly budget, then show at the enforcement seams that
(1) the key resolves the granted alias but is denied an ungranted one
(deny-by-default, P-B control store) and (2) a reservation within the identity's
budget is admitted while the one that would exceed it is refused with the typed
P1017 identity-budget rejection (P-C reservation seam). The management ROUTES
themselves are covered against the fake client in
explabs/api/routes/identities_test.py; this asserts the rows they produce are
honored by the runtime.
"""

from __future__ import annotations

import hashlib
import time
import uuid

import psycopg
import pytest
from exp.runtime.gateway.contracts import (
    GatewayApiSurface,
    GatewayMessage,
    GatewayRequest,
)
from exp.runtime.gateway.sqlite.store import AliasNotGrantedError

from explabs.gateway.conftest import GatewayHarness
from explabs.gateway.control_store import PostgresGatewayControlStore
from explabs.gateway.db import GatewayDatabase


def _request(content: str) -> GatewayRequest:
    """Build one bounded request whose content is never persisted."""
    return GatewayRequest(
        surface=GatewayApiSurface.CHAT_COMPLETIONS,
        messages=(GatewayMessage(role="user", content=content),),
        maximum_output_tokens=16,
    )


def _seed_identity(harness: GatewayHarness, org_id: str, identity_id: str, name: str) -> None:
    """Insert one named identity, exactly as the create-identity route does."""
    harness.connection.execute(
        """
        insert into public.gateway_identities (identity_id, org_id, display_name)
        values (%s, %s, %s)
        """,
        (identity_id, org_id, name),
    )


def _issue_key(harness: GatewayHarness, org_id: str, identity_id: str) -> str:
    """Insert one key under an identity, as the per-identity mint route does."""
    raw_key = f"xpl_e2e_{uuid.uuid4().hex}"
    harness.connection.execute(
        """
        insert into public.api_keys (id, org_id, name, key_prefix, key_hash, identity_id)
        values (%s, %s, 'e2e', %s, %s, %s)
        """,
        (
            str(uuid.uuid4()),
            org_id,
            raw_key[:12],
            hashlib.sha256(raw_key.encode()).hexdigest(),
            identity_id,
        ),
    )
    return raw_key


@pytest.mark.integration
def test_identity_key_grant_authorizes_only_granted_aliases(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A key under a new identity resolves only the aliases granted to it."""
    store = PostgresGatewayControlStore(gateway_db)
    org_id = gateway_harness.seed_org()
    _seed_identity(gateway_harness, org_id, "data-team-e2e", "Data Team")
    raw_key = _issue_key(gateway_harness, org_id, "data-team-e2e")

    # Two active aliases, neither auto-granted; grant only the first.
    granted = gateway_harness.activate_alias(org_id=org_id, seed_grants=False)
    ungranted = gateway_harness.activate_alias(org_id=org_id, seed_grants=False)
    gateway_harness.grant_alias("data-team-e2e", granted.alias_id, org_id=org_id)

    deadline = time.monotonic() + 30
    snapshot = store.authorize_request(
        raw_key=raw_key,
        alias=granted.alias_name,
        request=_request("go"),
        deadline_monotonic=deadline,
    )
    assert snapshot.identity_id == "data-team-e2e"
    assert snapshot.alias == granted.alias_name

    # Deny-by-default: an alias the identity was never granted is refused, even
    # though it is active and in the org's own namespace.
    with pytest.raises(AliasNotGrantedError, match="not granted"):
        store.authorize_request(
            raw_key=raw_key,
            alias=ungranted.alias_name,
            request=_request("go"),
            deadline_monotonic=deadline,
        )

    granted_names = store.granted_aliases(raw_key=raw_key)
    assert granted.alias_name in granted_names
    assert ungranted.alias_name not in granted_names


@pytest.mark.integration
def test_identity_budget_blocks_reservation_past_the_cap(
    gateway_harness: GatewayHarness, gateway_db: GatewayDatabase
) -> None:
    """A per-identity monthly budget refuses the reservation that would exceed it.

    Drives the reservation seam (gateway_accept_request -> gateway_start_attempt)
    directly: the first dispatch fits under the $1 identity cap and reserves; the
    second would push the identity past it and is refused with the typed
    P1017 identity-budget SQLSTATE (P-C), while the balances read seam reports
    exactly the reserved amount the meter must show.
    """
    org_id = gateway_harness.seed_org()
    _seed_identity(gateway_harness, org_id, "capped-e2e", "Capped")
    _issue_key(gateway_harness, org_id, "capped-e2e")
    alias = gateway_harness.activate_alias(org_id=org_id, seed_grants=False)
    gateway_harness.grant_alias("capped-e2e", alias.alias_id, org_id=org_id)

    # The capped identity's key id, for wiring requests to it.
    key_row = gateway_harness.fetch_one(
        "select id from public.api_keys where identity_id = %s", ("capped-e2e",)
    )
    assert key_row is not None
    api_key_id = str(key_row[0])

    period_row = gateway_harness.fetch_one(
        "select to_char(now() at time zone 'UTC', 'YYYY-MM')", ()
    )
    assert period_row is not None
    period = str(period_row[0])

    # A $1.00 monthly cap on the identity (as the set-budget route writes it).
    gateway_harness.connection.execute(
        """
        insert into public.gateway_budgets
          (budget_id, org_id, period, scope_kind, identity_id, limit_micro_usd)
        values (%s, %s, %s, 'identity', %s, 1000000)
        """,
        (f"budget-{uuid.uuid4().hex}", org_id, period, "capped-e2e"),
    )

    def _accept(request_id: str) -> None:
        gateway_harness.connection.execute(
            """
            select public.gateway_accept_request(
              %s, %s, %s, %s, %s, 'chat_completions', %s, null, now() + interval '1 hour'
            )
            """,
            (
                request_id,
                org_id,
                api_key_id,
                alias.alias_name,
                alias.revision_id,
                hashlib.sha256(request_id.encode()).hexdigest(),
            ),
        )

    def _start(request_id: str, max_cost_micro_usd: int) -> None:
        gateway_harness.connection.execute(
            """
            select public.gateway_start_attempt(
              %s, %s, 0, 0, %s, 'prov', 'm-e2e', %s, %s,
              'host_managed', 'launch_catalog', now(),
              1000000, null, 1000000, null, %s
            )
            """,
            (
                request_id,
                org_id,
                f"dep-{alias.pool_id}",
                alias.pool_id,
                alias.catalog_sha256,
                max_cost_micro_usd,
            ),
        )

    # First reservation: $0.50 worst case fits under the $1.00 cap.
    _accept("e2e-under")
    _start("e2e-under", 500000)

    # Second reservation: $0.60 more would push the identity to $1.10 > $1.00 and
    # is refused at the seam with the identity-budget SQLSTATE.
    _accept("e2e-over")
    with pytest.raises(psycopg.errors.Error) as excinfo:
        _start("e2e-over", 600000)
    assert excinfo.value.sqlstate == "P1017"

    # The balances read seam reports the one admitted reservation as reserved
    # spend, so the meter equals what the gate counts.
    balance = gateway_harness.fetch_one(
        """
        select reserved_micro_usd, settled_micro_usd
        from public.gateway_budget_balances(%s, %s)
        where scope_kind = 'identity' and identity_id = %s
        """,
        (org_id, period, "capped-e2e"),
    )
    assert balance is not None
    assert balance[0] == 500000
    assert balance[1] == 0
