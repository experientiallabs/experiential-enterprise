-- ---------------------------------------------------------------------------
-- The founding admin's own credentials SURVIVE spend unlock (the product owner, 2026-08-27).
--
-- #622 introduced rotate_credentials_on_spend_unlock, which at the NULL->NOT NULL
-- transition of organizations.spend_unlocked_at revoked EVERY key an admin minted
-- while locked -- INCLUDING the founder's own instant-signup key -- and severed
-- the founder's pre-unlock sessions. That kills a legitimate user's working key
-- and session the instant they verify their email, which is bad product design:
-- the instant key a founder wired into their gateway should keep working through
-- and after verification.
--
-- This migration redefines the trigger to rotate EVERYONE EXCEPT the founding
-- admin. The founder's key(s) and session(s) are preserved untouched; only
-- NON-founder members added while the org was locked are torn down (keys revoked,
-- sessions severed, memberships evicted). That keeps the Greptile P1 defense --
-- an attacker who holds the pre-unlock founder session and invites a co-admin
-- they control still gets that co-admin fully evicted at reclaim, so they cannot
-- mint a fresh key and spend (key minting checks LIVE org membership) -- while no
-- longer punishing the legitimate founder.
--
-- The spend gate itself (organizations.spend_unlocked_at NULL = spend blocked) is
-- unchanged: spend stays gated until inbox proof.
--
-- ACCEPTED RESIDUAL RISK (the product owner, explicit): in the instant-signup-of-a-victim's-
-- email case, the ATTACKER is the "founder" (they created the org for victim@x
-- and hold its instant key), so preserving the founder's key means the attacker's
-- key now survives the victim's verification. An attacker who instant-signs-up
-- victim@x and waits for the real victim to click the verify link could then
-- spend the grant. This is bounded by the small welcome grant ($20) and the
-- per-IP / per-address signup rate limits, and the product owner has accepted it in favor of
-- never revoking a legitimate founder's working key. Do NOT re-add founder-key
-- revocation here.
-- ---------------------------------------------------------------------------

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

-- CREATE OR REPLACE preserves the existing trigger on public.organizations and
-- the function's grants (revoked from public/anon/authenticated).
