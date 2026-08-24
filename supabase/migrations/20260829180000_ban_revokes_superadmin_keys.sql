-- ---------------------------------------------------------------------------
-- Banning also revokes the user's SUPERADMIN keys (public.platform_admin_keys).
--
-- 20260829120000's record_user_ban revoked the customer keys the user minted
-- but left their xpladmin_ machine credentials live: the ban promises to
-- block "every sign-in method", yet a banned operator's superadmin key kept
-- authenticating (the two-factor auth check only consults platform_admins
-- membership, which a ban does not touch). Fold the superadmin revocation
-- into the same atomic ban transaction. Revocation stays one-way: unban
-- (clear_user_ban) never un-revokes, matching customer keys.
--
-- Same body as 20260829120000 plus the platform_admin_keys update.
-- ---------------------------------------------------------------------------

create or replace function public.record_user_ban(
  in_user_id uuid,
  in_banned_by uuid,
  in_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_bans (user_id, reason, banned_by)
  values (in_user_id, in_reason, in_banned_by)
  on conflict (user_id) do update
    set reason = excluded.reason,
        banned_by = excluded.banned_by,
        banned_at = pg_catalog.now();

  -- Personal keys only: created_by scoping (see 20260823010000) never touches
  -- keys other members minted, in this or any other org.
  update public.api_keys
     set revoked_at = pg_catalog.now()
   where created_by = in_user_id
     and revoked_at is null;

  -- Superadmin machine credentials die with the ban too: they authenticate
  -- outside GoTrue (bearer against the control API), so banned_until alone
  -- never touches them.
  update public.platform_admin_keys
     set revoked_at = pg_catalog.now()
   where user_id = in_user_id
     and revoked_at is null;

  -- Local Docker migrates before GoTrue creates its tables; on hosted
  -- Supabase the auth schema always exists. GoTrue consults banned_until on
  -- every token grant, refresh, and OTP verify, so this write IS the lockout.
  -- Deleting the sessions cascades the refresh tokens, so the banned user
  -- cannot outlive their current access token's JWT expiry.
  if pg_catalog.to_regclass('auth.users') is not null then
    update auth.users
       set banned_until = pg_catalog.now() + interval '876000 hours',
           updated_at = pg_catalog.now()
     where id = in_user_id;
  end if;
  if pg_catalog.to_regclass('auth.sessions') is not null then
    delete from auth.sessions where user_id = in_user_id;
  end if;
end;
$$;

revoke all on function public.record_user_ban(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_user_ban(uuid, uuid, text) to service_role;
