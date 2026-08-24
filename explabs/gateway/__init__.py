# Copyright (c) 2026 Experiential Labs. All rights reserved.

"""Hosted Experiential gateway: the platform database is the gateway's primary store.

In hosted mode the platform's Supabase Postgres IS the gateway's persistence,
plugged in through Experiential's storage callback Protocols (``GatewayControlStore``
and ``AttemptLedger``). Every write with a gateway invariant behind it goes
through the ``gateway_*`` security definer SQL functions, so the transaction
boundary always lives inside Postgres and there is exactly one write path per
entity regardless of caller. The package also builds Experiential catalog snapshots
from platform model rows (``catalog``/``credentials``) and composes the
runnable gateway worker process (``worker``).
"""
