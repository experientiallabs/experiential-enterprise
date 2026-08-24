-- The signup page prefill needs org context for join invites: an invitee
-- following an org invite link should see which organization and role they
-- are accepting, the same way tenant invitees see their project. Postgres
-- cannot alter a function's result columns in place, so the definer RPC is
-- dropped and recreated with the wider row.
drop function public.lookup_org_invitation(text);

create function public.lookup_org_invitation(invite_token text)
returns table (
  email text,
  project_name text,
  org_name text,
  invited_role text,
  expires_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    invitations.email,
    invitations.project_name,
    orgs.name,
    invitations.role,
    invitations.expires_at
  from public.org_invitations invitations
  left join public.organizations orgs on orgs.id = invitations.org_id
  where invitations.token = invite_token
    and invitations.accepted_at is null
    and invitations.revoked_at is null
    and invitations.expires_at > now();
$$;

revoke all on function public.lookup_org_invitation(text) from public;
grant execute on function public.lookup_org_invitation(text) to anon, authenticated, service_role;
