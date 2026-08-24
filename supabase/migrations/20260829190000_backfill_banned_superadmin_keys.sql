-- ---------------------------------------------------------------------------
-- Backfill: bans recorded before 20260829180000 left the banned operator's
-- superadmin keys live. record_user_ban now revokes them in the ban
-- transaction, but it only runs on NEW bans — every account already sitting in
-- public.user_bans keeps whatever xpladmin_ credential it held. Revoke those
-- once here so the invariant "a banned account holds no live credential" is
-- true of the existing data too. Rows are kept (operator audit trail); only
-- revoked_at is stamped, and revocation stays one-way.
-- ---------------------------------------------------------------------------

update public.platform_admin_keys
   set revoked_at = pg_catalog.now()
 where revoked_at is null
   and user_id in (select user_id from public.user_bans);
