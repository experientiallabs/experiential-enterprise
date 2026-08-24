-- 20260826140000 added a GoTrue-absent early return so fresh Docker stacks can
-- seed the operator org before auth.users exists. 20260827000000 then replaced
-- rotate_credentials_on_spend_unlock to preserve the founding admin's keys and
-- dropped that guard (its timestamp is later, so it wins on a full migrate).
-- Local-stack migrate-and-seed then fails again with
-- relation "auth.users" does not exist.
--
-- Restore the guard on top of the founder-preserving body. Hosted projects
-- always have both GoTrue relations, so rotation semantics there are unchanged.

create or replace function public.rotate_credentials_on_spend_unlock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The founding admin: the earliest-joined admin (what unlock_founder_spend
  -- keys on), tie-broken by user_id. The founder is TRUSTED and preserved; only
  -- other members added while locked are rotated.
  v_founder pg_catalog.uuid;
begin
  -- Fresh Docker stacks migrate and seed before GoTrue creates auth.users and
  -- auth.sessions. The seeded operator org INSERT lands here; without this
  -- return the auth.users read fails the whole seed. There are no credentials
  -- to rotate yet (no user-minted keys, no sessions). Hosted projects always
  -- have both relations.
  if pg_catalog.to_regclass('auth.users') is null
     or pg_catalog.to_regclass('auth.sessions') is null then
    return new;
  end if;

  -- Only on the FIRST unlock: an INSERT already carrying spend_unlocked_at
  -- (seeded operator org; nothing to rotate) or an UPDATE transitioning it from
  -- null (an instant-signup/zero-click org unlocking when the founder proves the
  -- inbox).
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
  -- founder proved the inbox. The founding admin is TRUSTED: their key(s) and
  -- session(s) are left completely untouched, so their instant-signup key keeps
  -- working through verification. Only NON-founder members (an attacker-added
  -- co-admin) are torn down.

  -- 1. Revoke keys of THIS org that a NON-FOUNDER member minted while locked.
  --    The founder's own instant key is deliberately preserved. Scoped to
  --    keys.org_id = new.id so unlocking org A never touches keys in org B.
  update public.api_keys keys
     set revoked_at = pg_catalog.now()
    from public.organization_members members
   where members.org_id = new.id
     and members.user_id <> v_founder
     and keys.org_id = new.id
     and keys.created_by = members.user_id
     and keys.revoked_at is null;

  -- 2. Sever the sessions of every NON-FOUNDER member (an attacker-added
  --    co-admin), so no such pre-reclaim session can act on the org. The
  --    founder's sessions are NOT severed -- their instant-signup session (and
  --    the verifying session) keep working.
  delete from auth.sessions sessions
   using public.organization_members members
   where members.org_id = new.id
     and members.user_id <> v_founder
     and sessions.user_id = members.user_id;

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
