-- Copyright (c) 2026 Experiential Labs. All rights reserved.
-- Migration-version tombstone for the gateway-only draft previously pushed on
-- PR #626. Its Supabase preview branch applied this version before the PR was
-- rewritten around raw trace projection. Keeping the version lets that remote
-- preview reconcile without recreating the retired gateway outbox on a fresh
-- database.

do $$
begin
  null;
end
$$;
