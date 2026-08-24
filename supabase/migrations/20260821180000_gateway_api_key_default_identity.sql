-- gw-identity P-B companion: every api_keys row must hang off an identity so
-- deny-by-default authorization (control_store.authorize_request) can resolve a
-- grant. The dashboard/API key paths (POST /api/keys, /api/activate) insert keys
-- WITHOUT an identity_id, which under P-B authenticate but authorize nothing
-- (every created key unusable). A BEFORE INSERT trigger assigns the org's default
-- identity when the caller left identity_id null, covering every insert path
-- uniformly. Get-or-create: the default identity is normally seeded by P-A's
-- backfill and the new-org trigger, but the insert here (on conflict do nothing)
-- makes the assignment self-sufficient for any org whose identity row does not
-- yet exist, so a key is never left with a null identity. The grant that makes
-- the key usable comes from P-A's backfill / the new-org public-grant seed.

create function public.gateway_api_key_assign_default_identity()
returns pg_catalog.trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.identity_id is null then
    -- Get-or-create the org's default identity (id 'org-' || org_id), matching
    -- the control store's synthetic mapping and P-A's backfill convention.
    insert into public.gateway_identities (identity_id, org_id, display_name)
      values ('org-' || new.org_id, new.org_id, 'Default')
      on conflict (identity_id) do nothing;
    new.identity_id := 'org-' || new.org_id;
  end if;
  return new;
end;
$$;

revoke all on function public.gateway_api_key_assign_default_identity()
  from public, anon, authenticated, service_role;

comment on function public.gateway_api_key_assign_default_identity() is
  'BEFORE INSERT on api_keys: assigns the org default identity (id ''org-'' || org_id) when the caller left identity_id null, get-or-creating the identity row so every dashboard/API-created key hangs off an identity for P-B deny-by-default authorization.';

create trigger api_keys_assign_default_identity
  before insert on public.api_keys
  for each row execute function public.gateway_api_key_assign_default_identity();
