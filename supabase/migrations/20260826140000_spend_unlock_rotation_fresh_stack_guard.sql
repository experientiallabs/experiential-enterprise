-- Fresh-stack guard for rotate_credentials_on_spend_unlock (gw/analytics,
-- fixing a 20260826000000 regression): the seed's operator-org upsert fires
-- this trigger before GoTrue has created auth.users/auth.sessions on a fresh
-- Docker stack, so every local-stack migrate-and-seed (and the Local stack
-- integration CI gate) failed with 'relation "auth.users" does not exist'.
-- The function is re-created verbatim with one early return when the GoTrue
-- relations are absent; rotation semantics on hosted stacks are unchanged.

create or replace function public.rotate_credentials_on_spend_unlock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The founding admin: the earliest-joined admin (what unlock_founder_spend
  -- keys on), tie-broken by user_id. The ONLY member trusted at reclaim.
  v_founder pg_catalog.uuid;
begin
  -- Fresh Docker stacks migrate and seed before GoTrue creates auth.users and
  -- auth.sessions; the seeded operator org's INSERT lands here and errored on
  -- the auth.users read, failing every fresh-stack seed (found 2026-08-22).
  -- Without GoTrue there are no credentials to rotate -- no user-minted keys,
  -- no sessions -- so skip, the same ordering deferral every auth.users
  -- consumer in this repo uses. Hosted projects always have both relations.
  if pg_catalog.to_regclass('auth.users') is null
     or pg_catalog.to_regclass('auth.sessions') is null then
    return new;
  end if;

  -- Only on the FIRST unlock: an INSERT already carrying spend_unlocked_at
  -- (seeded operator org; no pre-unlock credentials to rotate) or an UPDATE
  -- transitioning it from null (an instant-signup/zero-click org unlocking when
  -- the founder proves the inbox).
  if new.spend_unlocked_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.spend_unlocked_at is not null then
    return new;
  end if;
  -- Seeded/demo orgs manage their own keys; never rotate them. Skip when any
  -- founding admin of this org is a seed/demo account. (The demo seed repoints
  -- explabs.seed_admin_email at each demo email as it inserts it.)
  if exists (
    select 1
      from public.organization_members members
      join auth.users users on users.id = members.user_id
     where members.org_id = new.id
       and members.role = 'admin'
       and users.email in (
         nullif(pg_catalog.current_setting('explabs.seed_admin_email', true), ''),
         nullif(pg_catalog.current_setting('explabs.demo_seed_email', true), '')
       )
  ) then
    return new;
  end if;

  select founding.user_id into v_founder
    from public.organization_members founding
   where founding.org_id = new.id
     and founding.role = 'admin'
   order by founding.created_at asc, founding.user_id asc
   limit 1;

  -- The trigger fires AT the first unlock transition, so every membership that
  -- exists right now was added while the org was still locked -- i.e. before the
  -- founder proved the inbox. Only v_founder is trusted; every other member and
  -- their credentials are torn down (see the credit-theft chain in the header).

  -- 1. Revoke every key of THIS org an admin minted while locked (the founder's
  --    and any co-admin's). Scoped to keys.org_id = new.id so unlocking org A
  --    never revokes the founder's legitimate keys in another org B.
  update public.api_keys keys
     set revoked_at = pg_catalog.now()
    from public.organization_members members
   where members.org_id = new.id
     and members.role = 'admin'
     and keys.org_id = new.id
     and keys.created_by = members.user_id
     and keys.revoked_at is null;

  -- 2. Sever sessions of this org's members, keeping ONLY the founder's NEWEST
  --    (the verifying session that drove the unlock). This drops the attacker's
  --    retained founder session AND every co-admin's session, so no pre-reclaim
  --    session can act on the org. "Newest per founder" (not a time margin) keeps
  --    the verifying session even if the unlock lands seconds after it was minted.
  delete from auth.sessions sessions
   using public.organization_members members
   where members.org_id = new.id
     and sessions.user_id = members.user_id
     and not (
       members.user_id = v_founder
       and sessions.created_at = (
         select pg_catalog.max(newer.created_at)
           from auth.sessions newer
          where newer.user_id = v_founder
       )
     );

  -- 3. Evict every non-founder membership. An attacker holding the pre-unlock
  --    founder session could have invited a co-admin they control; without this
  --    they would remain an admin and mint a FRESH key to spend the unlocked
  --    credits (key minting checks LIVE membership, so removing it is what
  --    actually stops the re-mint). Anyone removed here re-joins after reclaim.
  delete from public.organization_members evicted
   where evicted.org_id = new.id
     and evicted.user_id <> v_founder;

  return new;
end;
$$;
