-- Close the gateway_grants org-integrity hole (F3): gateway_grants.org_id is
-- denormalized and was unconstrained against gateway_identities.org_id, so a
-- grants row whose org_id mismatches its identity's org AUTHORIZED AT RUNTIME
-- (the control store joins on api_keys.identity_id) while staying INVISIBLE
-- to the management UI (which lists grants by org_id). The composite foreign
-- key below makes that state unrepresentable: a grant row must name the
-- exact (org_id, identity_id) pair that exists on gateway_identities (which
-- already carries the matching table-level unique). The single-column
-- identity_id FK becomes redundant — the composite key subsumes both its
-- reference and its ON DELETE CASCADE — and is dropped in the same statement
-- so there is no window with double-cascade bookkeeping.
--
-- (The companion F3 retired-role fix called out by the enterprise audit —
-- list_agent_connector_credentials gating on the retired 'member' role —
-- already shipped in 20260724110000_two_role_credential_bridge.sql; no live
-- definer gates on retired roles today.)

alter table public.gateway_grants
  drop constraint gateway_grants_identity_id_fkey,
  add constraint gateway_grants_org_identity_fkey
    foreign key (org_id, identity_id)
    references public.gateway_identities (org_id, identity_id)
    on delete cascade;
