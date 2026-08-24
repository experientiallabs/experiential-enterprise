-- Domain-based organization join requests.
--
-- A person who signs up with an email whose DOMAIN matches an organization
-- registered for that domain keeps their own personal org (signup is never
-- blocked; the provisioning trigger is untouched) and may REQUEST access to the
-- matching org. An org admin approves or denies; approval grants membership.
--
-- Domain -> org associations are operator-controlled (platform admins), never
-- self-asserted by an org: a tenant that could claim '@gmail.com' would vacuum
-- up every public-domain signup, so this is deliberately NOT an org-admin
-- write surface. The offer is only shown for a domain that maps to a real org
-- AND only once the requester's email is verified (auth.users.email_confirmed_at
-- is set) -- the same inbox-ownership proof the spend gate relies on, since
-- email confirmation is otherwise disabled.

-- Verified domain -> org associations. One org per domain keeps the
-- "request access to <Org>" offer unambiguous.
create table public.org_domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  domain text not null check (
    domain = lower(domain)
    and position('@' in domain) = 0
    and position('.' in domain) > 1
  ),
  created_at timestamptz not null default now(),
  created_by uuid
);

create unique index org_domains_domain_key on public.org_domains (domain);
create index org_domains_org_idx on public.org_domains (org_id);

-- Pending / decided join requests. The requester's email is denormalized onto
-- the row so the admin roster reads without joining auth.users (which RLS
-- clients cannot read) and so a later email change never rewrites history.
--
-- user_id is a plain uuid, not a FK to auth.users: the local integration stack
-- applies public migrations before GoTrue creates the auth schema, so a
-- constraint on auth.users fails at DDL time. The platform convention is to
-- touch auth.users only inside function bodies (see auth_user_verification
-- below), never as a table constraint. The requester is validated through that
-- definer path, not a hard FK.
create table public.org_join_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  email text not null check (position('@' in email) > 1),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid
);

-- One live request per (org, user); decided rows remain as history.
create unique index org_join_requests_pending_org_user
  on public.org_join_requests (org_id, user_id)
  where status = 'pending';
create index org_join_requests_org_pending_idx
  on public.org_join_requests (org_id)
  where status = 'pending';
create index org_join_requests_user_idx on public.org_join_requests (user_id);

grant select, insert, update, delete on public.org_domains to service_role;
grant select on public.org_domains to authenticated;
grant select, insert, update, delete on public.org_join_requests to service_role;
grant select on public.org_join_requests to authenticated;

alter table public.org_domains enable row level security;
alter table public.org_join_requests enable row level security;

-- org_domains: org admins (and platform admins) may read their org's domain
-- associations; writes go through the platform-admin service-role API only, so
-- there is no authenticated write policy.
create policy org_domains_select_admin
  on public.org_domains
  for select
  to authenticated
  using (public.is_org_admin(org_id) or public.is_platform_admin());

-- org_join_requests: the requester sees their own requests; org admins see
-- requests for their org; platform admins see all. Writes go through the
-- service-role API (RLS bypassed) so the domain-match and verification gating
-- stays in one code path.
create policy org_join_requests_select_own
  on public.org_join_requests
  for select
  to authenticated
  using (user_id = public.authenticated_user_id());

create policy org_join_requests_select_admin
  on public.org_join_requests
  for select
  to authenticated
  using (public.is_org_admin(org_id) or public.is_platform_admin());

-- Read one user's verification state for the domain-join gate. The domain
-- match is authoritative server-side, and email confirmation is the proof of
-- inbox ownership. auth.users is not reachable by RLS clients, so this definer
-- function exposes exactly the two fields the gate needs -- to the calling
-- service role, a platform admin, or the user reading their own state.
create function public.auth_user_verification(target_user_id uuid)
returns table (email text, email_confirmed_at timestamptz)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not (
    public.is_platform_admin()
    or coalesce(
         nullif(current_setting('request.jwt.claim.role', true), ''),
         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
       ) = 'service_role'
    or target_user_id = public.authenticated_user_id()
  ) then
    raise exception 'not authorized to read verification state';
  end if;
  return query
    select users.email::text, users.email_confirmed_at
    from auth.users users
    where users.id = target_user_id;
end;
$$;

revoke all on function public.auth_user_verification(uuid) from public, anon;
grant execute on function public.auth_user_verification(uuid) to authenticated, service_role;

-- Approve a pending request atomically: settle it AND grant membership in one
-- transaction, so a crash can never leave a request approved without access
-- (or access without a decision record). A request that already settled --
-- because a concurrent DENY won, or this is a replay -- returns unchanged and
-- grants nothing. service_role only: the org-admin gate lives in the API route
-- that calls this through the service-role client; a browser session cannot
-- reach it (nor the RLS-blocked org_join_requests UPDATE) directly.
create function public.approve_org_join_request(p_request_id uuid, p_decided_by uuid)
returns table (
  id uuid,
  org_id uuid,
  user_id uuid,
  email text,
  status text,
  created_at timestamptz,
  decided_at timestamptz,
  decided_by uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  req public.org_join_requests;
begin
  update public.org_join_requests requests
    set status = 'approved', decided_at = now(), decided_by = p_decided_by
    where requests.id = p_request_id and requests.status = 'pending'
    returning requests.* into req;

  if found then
    insert into public.organization_members (org_id, user_id, role)
    values (req.org_id, req.user_id, 'user')
    on conflict (org_id, user_id) do nothing;
  else
    -- Already decided (deny race or replay): report the settled row, grant nothing.
    select requests.* into req
    from public.org_join_requests requests
    where requests.id = p_request_id;
  end if;

  if req.id is null then
    return;
  end if;
  return query
    select req.id, req.org_id, req.user_id, req.email, req.status,
           req.created_at, req.decided_at, req.decided_by;
end;
$$;

revoke all on function public.approve_org_join_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_org_join_request(uuid, uuid) to service_role;
