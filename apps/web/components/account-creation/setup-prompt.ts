// The shared "create an Experiential Labs account from your coding agent" steps.
// Every agent-based onboarding prompt (trace telemetry, project onboarding) uses
// ONE signup model: the founder's agent asks them for their email and POSTs it
// to the public instant-signup endpoint, coming back with a working `xpl_`
// org key IMMEDIATELY — no browser, no device code, no password. The account is
// created UNVERIFIED: it can do everything (wire the gateway, land traces as
// telemetry, read the dashboard) EXCEPT draw platform credits, which unlock
// asynchronously when the founder clicks the verification email.
//
// First person and imperative by design: the agent follows it literally, so no
// vague "you can", and it never asks the agent to invent a credential.

/**
 * The instant, zero-browser account-creation steps, numbered 1–4. The agent
 * asks the founder for their email (never scavenges one from local files or
 * git config), POSTs it to the public instant-signup endpoint — a Next.js
 * route on the WEB origin
 * (`${web}/api/signup/instant`), NOT the FastAPI api host that serves `/v1` —
 * and comes back with a working `xpl_` key immediately: no device code, no
 * browser approval, no password. The account is created UNVERIFIED; it can do
 * everything except draw platform credits, which unlock when the founder clicks
 * the verification email. The leading step numbers are fixed at 1–4 so the
 * composing prompts continue at step 5.
 *
 * @param web - Public web origin (instant-signup route + dashboard + sign-in;
 *   trailing slashes trimmed).
 * @param api - Public API base URL (`/v1` gateway; trailing slashes trimmed).
 * @returns Steps 1–4 as a single block, starting "1." and ending "regardless.".
 */
export function buildInstantSignupSteps(web: string, api: string): string {
  return `1. Ask me for my email address, it is the one thing signup needs. Ask me
   directly ("What's your email? I'll create your Experiential Labs account
   with it.") and wait for my answer. Use exactly the address I give you.
   Never invent or guess an address, and never go looking for one in my
   files, git config, or shell history. Call the result MY_EMAIL.

2. Create my account instantly, no browser, no password, no code.
   POST ${web}/api/signup/instant   (no auth)
   Header: Content-Type: application/json
   Body: {"email": "<MY_EMAIL>"}
   On 200 capture: api_key (an xpl_ key, this is mine, keep it secret), org_id,
   credits_granted, verification_required, overview_url. Handle the others:
     - 409 account_exists  -> I already have an account; stop and tell me to
       sign in at ${web}/signin to get a key (don't retry with another email).
     - 403 signup_disabled -> signups are off right now; tell me.
     - 429 rate_limited    -> too many signups from here; wait, then retry once.
     - 400 invalid_request -> the email was rejected; ask me for a valid one.
   Store the api_key as EXPLABS_API_KEY in my env; never print the full key more
   than once.

3. Wire an OpenAI client to the gateway.
   base_url = "${api}/v1"
   api_key  = EXPLABS_API_KEY (the xpl_ key from step 2). One header only:
   Authorization: Bearer <api_key>.

4. Confirm the key is live, this does NOT spend credits.
   GET ${api}/v1/models with the key -> the models my account can call. Do NOT
   make a paid chat completion yet: my credits stay locked until I verify my
   email (I do that at the very end), and a paid call would be refused until
   then. Landing my traces as telemetry works regardless.`;
}
