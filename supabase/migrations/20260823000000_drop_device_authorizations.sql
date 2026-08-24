-- Remove the OAuth device-authorization / device-code account-creation feature.
--
-- Every agent-based signup now unifies on the instant email signup
-- (POST /api/signup/instant): the agent creates a real email account with a
-- working xpl_ key immediately, and platform credits unlock only once the
-- founder verifies their email (the P1025 spend gate in
-- gateway_start_attempt). The device-code grant a coding agent used to redeem
-- through the browser /activate approval step is gone, along with its API
-- endpoints (/api/signup/device/start|poll) and web surface, so the backing
-- table and its expiry sweep have no remaining caller.
--
-- Reverses everything 20260821140000_device_authorizations.sql created (that
-- migration stays as immutable history). The table drop cascades its indexes,
-- policies, and grants; the expiry function is dropped explicitly.

drop function if exists public.expire_device_authorizations();

drop table if exists public.device_authorizations cascade;
