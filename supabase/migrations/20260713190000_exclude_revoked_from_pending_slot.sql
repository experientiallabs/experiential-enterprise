-- A revoked invite is history, not a live slot-holder. The pending unique
-- slot previously keyed on accepted_at alone, so a revoked invite with a
-- future expiry blocked re-inviting the same address: the add-member route's
-- pending lookup rightly ignores revoked rows, its insert then hit the
-- duplicate, and recovery found nothing -- a dead end telling the operator to
-- revoke an invite that already was. Scope the slot (and the signup lookup
-- index) to live pending invites; revoked rows remain as history alongside
-- accepted ones.

drop index public.org_invitations_pending_org_email;
create unique index org_invitations_pending_org_email
  on public.org_invitations (org_id, lower(email))
  where accepted_at is null and revoked_at is null;

drop index public.org_invitations_pending_email_idx;
create index org_invitations_pending_email_idx
  on public.org_invitations (lower(email))
  where accepted_at is null and revoked_at is null;
