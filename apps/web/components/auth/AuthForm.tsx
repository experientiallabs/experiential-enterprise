"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import { LastUsedBadge, OAuthButtons, OAuthDivider } from "@/components/auth/OAuthButtons";
import { readLastAuthMethod, recordAuthMethod } from "@/lib/auth/last-used";
import { safePrefillEmail } from "@/lib/auth/redirects";

// Error codes set by the /auth/oauth and /auth/callback redirects.
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  signup_disabled: "Account creation is currently disabled. Ask an administrator for an invite.",
  account_exists:
    "An account already exists for this email. Enter your email above to get a sign-in code.",
  otp_send_failed: "We couldn't send a code. Check your email and try again.",
  rate_limited: "A code was sent recently. Check your inbox, or wait a minute and try again.",
  oauth_failed: "Sign-in with the identity provider failed. Please try again.",
  provider_disabled:
    "That sign-in provider isn't configured yet. Use your email, or ask an administrator to enable it.",
  unknown_provider: "That sign-in provider is not supported.",
  invite_invalid: "This invite link is invalid or has expired.",
  // Set by the /auth/sso step-up start when the org's IdP cannot answer yet.
  sso_unavailable:
    "Single sign-on for that organization isn't reachable yet. Ask an organization admin to finish the identity-provider setup.",
  sso_org_missing: "That single sign-on link is missing its organization."
};

/**
 * The form renders on two grounds with one behavior: `dark` is the /signin
 * page over the contribution grid (onboard tokens, brightened for presence
 * against the grid), `light` is the in-app login modal on the product's
 * --surface tokens.
 */
export type AuthTone = "dark" | "light";

type ToneClasses = {
  input: string;
  label: string;
  smallButton: string;
  errorBox: string;
  noticeBox: string;
  submit: string;
};

const TONE: Record<AuthTone, ToneClasses> = {
  dark: {
    // Brighter than the onboard tokens for the same reason as the dark
    // OAuth buttons: presence against the grid, without touching shared tokens.
    input:
      "w-full px-4 py-3 rounded-xl border border-white/20 bg-white/[0.08] text-sm text-onboard-text placeholder:text-onboard-muted/50 focus:outline-none focus:border-white/40 focus:shadow-[0_0_15px_rgba(255,255,255,0.05)] transition-all",
    label:
      "block text-[11px] font-semibold text-onboard-muted mb-2 uppercase tracking-[0.15em] font-mono",
    smallButton:
      "text-[10px] font-mono uppercase tracking-[0.15em] text-onboard-muted hover:text-onboard-text transition-colors",
    errorBox: "px-4 py-3 rounded-xl bg-danger/10 border border-danger/20 text-sm text-danger",
    noticeBox:
      "mt-4 px-4 py-3 rounded-xl border border-onboard-border bg-onboard-input text-sm text-onboard-text space-y-3",
    submit: "border-transparent bg-onboard-text text-onboard-bg hover:bg-white"
  },
  light: {
    input:
      "w-full px-3.5 py-2.5 rounded-[var(--radius-md)] border border-line bg-background text-sm text-ink placeholder:text-muted-2 focus:outline-none focus:border-line-strong transition-colors",
    label: "block mb-2 mono-label font-semibold",
    smallButton:
      "text-[10px] font-mono uppercase tracking-[0.15em] text-muted hover:text-ink transition-colors",
    errorBox:
      "px-4 py-3 rounded-[var(--radius-md)] bg-danger-soft border border-danger/20 text-[13px] text-danger",
    noticeBox:
      "mt-4 px-4 py-3 rounded-[var(--radius-md)] border border-line bg-surface-subtle text-[13px] text-ink space-y-3",
    submit: "border-transparent bg-ink text-white hover:bg-ink/85"
  }
};

/** The prose behind a redirect's ?error= code; unknown codes read generically. */
export function authErrorMessage(code: string): string {
  return AUTH_ERROR_MESSAGES[code] ?? "Unable to sign in.";
}

type AuthFormProps = {
  inviteToken: string | null;
  prefillEmail: string | null;
  tone: AuthTone;
  /**
   * Same-origin path the OAuth round-trip returns to (the provider redirect
   * necessarily leaves the page). The modal rides its re-open marker in here;
   * the /signin page passes its post-login destination.
   */
  oauthNext: string;
  /** Error code surfaced by an /auth redirect (?error= on /signin). */
  initialErrorCode?: string | null;
  /**
   * When set, the form opens directly on the code-entry stage bound to this
   * address, WITHOUT sending a code — the caller already sent one. Used by the
   * /signup handler's existing-account bounce (?sent=1): it emailed a sign-in
   * code, so the visitor lands ready to enter it ("check your email to sign in").
   */
  initialCodeSentTo?: string | null;
  /**
   * Send the emailed code once on mount when `prefillEmail` is a usable
   * address, landing the form straight on the code-entry stage. Opt-in for
   * trusted funnels that already collected the address and need the client to
   * request the code, such as /yc. Marketing signup sends its code server-side
   * before the redirect. A plain prefilled invite link must NOT set this — it
   * would send unsolicited code email to an address the visitor never typed.
   */
  autoSendCode?: boolean;
  /** Runs after an email-code success; OAuth resolves via oauthNext instead. */
  onSuccess: (outcome: { created: boolean }) => void;
};

/**
 * The one sign-in form, hosted by the /signin page (dark, invite-aware) and
 * the in-app login modal (light). Passwordless is FIRST-CLASS and the default:
 * Google/GitHub OAuth and an emailed 6-digit sign-in code (enter an email, we
 * send a code, entering it signs you in — and creates the account on first use
 * if signups are open; the code IS the inbox proof, so a first sign-in is a
 * verified account). Signup never sets a user-known password.
 *
 * Password sign-in is an OPTIONAL alternative (the product owner, 2026-08-21): the "Sign in
 * with password" toggle reveals email+password fields that POST
 * /auth/password/signin, and "Forgot password?" (or "set a password" for a
 * passwordless account) emails a recovery link via /auth/password/reset. A
 * brand-new account has no password until the user opts in through that flow.
 * The password 401 DISTINGUISHES account existence (owner decision, 2026-08-24,
 * bounded by the route's rate limits like /signup): a "no_account" rejection
 * reveals a "Create an account" affordance (routed into the emailed-code flow,
 * which creates the account on first use), while a "wrong_password" rejection
 * shows a specific "Wrong password" message beside the reset affordance and a
 * secondary emailed-code link. Exactly ONE branch renders per rejection: no
 * generic error box stacked with a code paragraph. Invite links stay code-only
 * (the token can only ride the emailed-code signup). The emailed-code path
 * itself STAYS account-existence-neutral.
 * (Marketing signup lives at /signup and starts the same code-first flow.)
 */
export function AuthForm({
  inviteToken,
  prefillEmail,
  tone,
  oauthNext,
  initialErrorCode = null,
  initialCodeSentTo = null,
  autoSendCode = false,
  onSuccess
}: AuthFormProps) {
  const classes = TONE[tone];
  const [email, setEmail] = useState(prefillEmail ?? initialCodeSentTo ?? "");
  const [error, setError] = useState<string | null>(
    initialErrorCode ? authErrorMessage(initialErrorCode) : null
  );
  // Informational, not a failure; renders in the quiet notice style.
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [codeWasLastUsed, setCodeWasLastUsed] = useState(false);
  const [passwordWasLastUsed, setPasswordWasLastUsed] = useState(false);
  // "code" is the passwordless default; "password" is the optional alternative.
  // Invite links stay code-only (the token rides the emailed-code signup).
  const [mode, setMode] = useState<"code" | "password">("code");
  const [password, setPassword] = useState("");
  // Which branch the last password 401 selected, or null when there is none.
  // "no_account" reveals the Create-an-account affordance (into the emailed-code
  // flow, which creates the account on first use); "wrong_password" shows the
  // specific "Wrong password" message with the reset + emailed-code offers.
  const [passwordRejection, setPasswordRejection] = useState<
    "no_account" | "wrong_password" | null
  >(null);
  // The address a code was sent to; non-null renders the code-entry stage.
  // Bound to the exact address — editing the email resets to the send stage.
  // Seeded from initialCodeSentTo when the caller already sent a code.
  const [codeSentTo, setCodeSentTo] = useState<string | null>(initialCodeSentTo);
  const [code, setCode] = useState("");
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  // Guards the one-shot auto-send below: once mount has evaluated the prefill,
  // it never sends again, so a re-render or strict-mode's double effect invoke
  // cannot email a second code.
  const autoSentRef = useRef(false);
  // De-dupe the OTP send. requestCode is reachable from several intents (the
  // auto-send effect, Continue, "Create an account", the code-mode submit), and
  // more than one can fire for a SINGLE user action (e.g. the auto-send effect
  // is still in flight when the user clicks Continue). GoTrue reuses the same
  // OTP token within smtp_max_frequency and emails it AGAIN, so the user gets
  // two identical codes. These refs make a send fire at most once per address:
  // requestedForEmailRef remembers the address a code was already requested for
  // (seeded when a caller pre-sent one via initialCodeSentTo), and
  // sendInFlightRef blocks a concurrent second send. Only an explicit "Resend
  // code" ({ force: true }) deliberately re-sends; editing the email clears both.
  const requestedForEmailRef = useRef<string | null>(
    initialCodeSentTo ? initialCodeSentTo.trim().toLowerCase() : null
  );
  const sendInFlightRef = useRef(false);

  // localStorage is read after mount so server and first client render agree.
  useEffect(() => {
    const lastUsed = readLastAuthMethod();
    setCodeWasLastUsed(lastUsed === "email_code");
    setPasswordWasLastUsed(lastUsed === "password");
  }, []);

  useEffect(() => {
    if (codeSentTo !== null) {
      codeInputRef.current?.focus();
    }
  }, [codeSentTo]);

  // The YC funnel already collected the founder's email to sign them in, so
  // fire the code send once on mount and land straight on the code-entry
  // stage instead of asking them to click Continue again. Evaluated exactly
  // once (the ref latches immediately, so a later keystroke never turns into
  // an unsolicited send), and only when the form is idle: an already-sent
  // code or a missing/malformed prefill keeps the manual flow. A failed send
  // stays on the send stage via requestCode's own error handling, so the
  // founder can retry.
  useEffect(() => {
    if (!autoSendCode || autoSentRef.current) {
      return;
    }
    autoSentRef.current = true;
    if (codeSentTo !== null || isSubmitting || safePrefillEmail(prefillEmail) === null) {
      return;
    }
    void requestCode();
    // Mount-only: the auto-send acts on the initial prefill, and the ref
    // makes it exactly-once, so later state changes must not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function requestCode(options?: { force?: boolean }): Promise<void> {
    const force = options?.force === true;
    const target = email.trim().toLowerCase();
    const alreadyRequested = requestedForEmailRef.current === target;
    // Skip a duplicate GoTrue send (it would email a second identical code): a
    // send is already in flight, or one already went out for this address and
    // this is not an explicit resend. Still advance to the code-entry stage so
    // whichever intent called is not stranded on the email stage.
    if (!force && (sendInFlightRef.current || alreadyRequested)) {
      if (alreadyRequested && !sendInFlightRef.current && codeSentTo === null) {
        setCode("");
        setCodeSentTo(email);
      }
      return;
    }
    sendInFlightRef.current = true;
    requestedForEmailRef.current = target;
    setError(null);
    setNotice(null);
    setIsSubmitting(true);
    try {
      let response: Response;
      try {
        response = await fetch("/auth/otp", {
          body: JSON.stringify({ email, inviteToken }),
          headers: { "content-type": "application/json" },
          method: "POST"
        });
      } catch {
        // The send did not reach GoTrue, so clear the guard to allow a retry.
        requestedForEmailRef.current = null;
        setError("Couldn't reach the server. Check your connection and try again.");
        return;
      }
      if (!response.ok) {
        requestedForEmailRef.current = null;
        const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof payload?.error === "string" ? payload.error : "Couldn't send the code.");
        return;
      }
      // The response is deliberately neutral about whether anything was sent
      // (no account-existence oracle); the stage copy stays neutral with it.
      setCode("");
      setCodeSentTo(email);
    } finally {
      sendInFlightRef.current = false;
      setIsSubmitting(false);
    }
  }


  async function verifyCode(): Promise<void> {
    if (codeSentTo === null) {
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      let response: Response;
      try {
        response = await fetch("/auth/otp/verify", {
          body: JSON.stringify({ email: codeSentTo, token: code }),
          headers: { "content-type": "application/json" },
          method: "POST"
        });
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        created?: unknown;
        error?: unknown;
      } | null;
      if (!response.ok) {
        setError(
          typeof payload?.error === "string"
            ? payload.error
            : "That code is invalid or has expired."
        );
        return;
      }
      recordAuthMethod("email_code");
      onSuccess({ created: payload?.created === true });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function signInWithPassword(): Promise<void> {
    setError(null);
    setNotice(null);
    setPasswordRejection(null);
    setIsSubmitting(true);
    try {
      let response: Response;
      try {
        response = await fetch("/auth/password/signin", {
          body: JSON.stringify({ email, password }),
          headers: { "content-type": "application/json" },
          method: "POST"
        });
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          code?: unknown;
          error?: unknown;
        } | null;
        // A 401 selects exactly ONE branch (no_account vs wrong_password) and
        // renders no generic error box; every other failure (400, 429, 5xx) is
        // a plain error the user fixes by editing fields or retrying.
        if (response.status === 401) {
          setPasswordRejection(payload?.code === "no_account" ? "no_account" : "wrong_password");
          return;
        }
        setError(
          typeof payload?.error === "string" ? payload.error : "Couldn't sign you in. Try again."
        );
        return;
      }
      recordAuthMethod("password");
      onSuccess({ created: false });
    } finally {
      setIsSubmitting(false);
    }
  }

  // "Forgot password?" / "set a password": emails a recovery link. Neutral about
  // account existence, matching the code path — the notice never asserts a send.
  async function requestPasswordReset(): Promise<void> {
    setError(null);
    setNotice(null);
    setPasswordRejection(null);
    if (email.trim().length === 0) {
      setError("Enter your email above first.");
      return;
    }
    setIsSubmitting(true);
    try {
      try {
        await fetch("/auth/password/reset", {
          body: JSON.stringify({ email }),
          headers: { "content-type": "application/json" },
          method: "POST"
        });
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
        return;
      }
      setNotice(`If an account exists for ${email}, a password reset link is on its way.`);
    } finally {
      setIsSubmitting(false);
    }
  }

  function switchMode(next: "code" | "password"): void {
    setMode(next);
    setError(null);
    setNotice(null);
    setPasswordRejection(null);
    setCodeSentTo(null);
    setPassword("");
  }

  // The way out of a password rejection (both "Create an account" for no_account
  // and "use a sign-in code" for wrong_password): switch to the emailed-code
  // flow and send the code to the address already typed (the user entered it
  // themselves, exactly like pressing Continue in code mode). Entering the code
  // signs them in (and creates the account on first use), so a no-account email
  // resolves here instead of dead-ending on the 401.
  async function continueWithEmailedCode(): Promise<void> {
    switchMode("code");
    await requestCode();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "password") {
      void signInWithPassword();
    } else if (codeSentTo === null) {
      void requestCode();
    } else {
      void verifyCode();
    }
  }

  const submitLabel =
    mode === "password"
      ? isSubmitting
        ? "Signing in..."
        : "Sign in"
      : codeSentTo !== null
        ? isSubmitting
          ? "Signing in..."
          : "Sign in"
        : isSubmitting
          ? "Sending code..."
          : "Continue";
  const showLastUsedBadge =
    mode === "password" ? passwordWasLastUsed : codeSentTo === null && codeWasLastUsed;

  return (
    <div>
      {/* An invite token can only ride the emailed-code signup: the provisioning
          trigger consumes it from signup metadata, and the OAuth callback
          carries no app state (the trigger fires during the provider exchange,
          before any app code runs). Offering OAuth on a tokened invite link
          would waste the invite, so it renders code-only. The buttons render
          unconditionally otherwise (the product owner, 2026-07-30): on a deployment whose
          GoTrue lacks the provider, the /auth/oauth route's settings check turns
          the click into the readable provider_disabled message rather than a
          broken dance. */}
      {inviteToken === null && (
        <>
          <OAuthButtons next={oauthNext} tone={tone} />
          <OAuthDivider tone={tone} />
        </>
      )}
      <form className="space-y-4" onSubmit={submit}>
        <div>
          <label htmlFor="signin-email" className={classes.label}>
            Email
          </label>
          <input
            autoComplete="email"
            autoFocus
            id="signin-email"
            name="email"
            onChange={(event) => {
              setEmail(event.target.value);
              // A sent code is bound to the address it was issued for; a new
              // address is a new intent, so clear the send guard too.
              setCodeSentTo(null);
              requestedForEmailRef.current = null;
            }}
            placeholder="you@company.com"
            required
            type="email"
            value={email}
            className={classes.input}
          />
        </div>
        {mode === "password" && (
          <div>
            <label htmlFor="signin-password" className={classes.label}>
              Password
            </label>
            <input
              autoComplete="current-password"
              id="signin-password"
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Your password"
              required
              type="password"
              value={password}
              className={classes.input}
            />
            {/* No account to reset in the no_account branch, so the reset
                affordance hides there; wrong_password keeps it as the way to
                recover a real account. */}
            {passwordRejection !== "no_account" && (
              <div className="flex items-center justify-end mt-1.5">
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => void requestPasswordReset()}
                  className={classes.smallButton}
                >
                  Forgot password?
                </button>
              </div>
            )}
          </div>
        )}
        {mode === "code" && codeSentTo !== null && (
          <div>
            <label htmlFor="signin-code" className={classes.label}>
              Sign-in code
            </label>
            <input
              autoComplete="one-time-code"
              id="signin-code"
              inputMode="numeric"
              maxLength={6}
              name="code"
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              pattern="\d{6}"
              placeholder="123456"
              ref={codeInputRef}
              required
              type="text"
              value={code}
              className={classes.input}
            />
            {/* Neutral on purpose: the send is neutral about account
                existence, so this copy must not assert a delivery. */}
            <div className="flex items-center justify-between mt-1.5 gap-3">
              <p className={`m-0 text-xs ${tone === "dark" ? "text-onboard-muted" : "text-muted"}`}>
                Enter the 6-digit code emailed to {codeSentTo}.
              </p>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => void requestCode({ force: true })}
                className={classes.smallButton}
              >
                Resend code
              </button>
            </div>
          </div>
        )}
        {notice && <div className={classes.noticeBox}>{notice}</div>}
        {error && <div className={classes.errorBox}>{error}</div>}
        {/* Exactly ONE branch per password 401: the route now distinguishes
            account existence (owner decision, bounded by its rate limits), so a
            rejection no longer stacks a generic error box with a code paragraph.
            no_account reveals a Create-an-account affordance into the
            emailed-code flow (which creates the account on first use);
            wrong_password names the failure and offers the reset + code escape
            hatches. Both animate in, matching the app's reveal idiom. */}
        {mode === "password" && passwordRejection === "no_account" && (
          <div className={`${classes.noticeBox} animate-reveal`}>
            <p className="m-0">
              No account for that email. Create one with a sign-in code: entering the emailed
              code signs you in and creates your account on first use.
            </p>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => void continueWithEmailedCode()}
              className={classes.smallButton}
            >
              Create an account
            </button>
          </div>
        )}
        {mode === "password" && passwordRejection === "wrong_password" && (
          <>
            <div className={`${classes.errorBox} animate-reveal`}>
              Wrong password. Reset it with &ldquo;Forgot password?&rdquo; above.
            </div>
            <div className={`${classes.noticeBox} animate-reveal`}>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => void continueWithEmailedCode()}
                className={classes.smallButton}
              >
                Sign in with an emailed code instead
              </button>
            </div>
          </>
        )}
        <button
          type="submit"
          disabled={isSubmitting}
          className={`relative w-full mt-2 px-6 py-3.5 rounded-full border font-semibold text-sm tracking-tight transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${classes.submit}`}
        >
          {submitLabel}
          {showLastUsedBadge && <LastUsedBadge inverted tone={tone} />}
        </button>
      </form>
      {/* Passwordless stays the default; password is the optional alternative.
          Invite links are code-only, so the toggle is hidden for them. */}
      {inviteToken === null && (
        <div className="mt-4 text-center">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => switchMode(mode === "password" ? "code" : "password")}
            className={classes.smallButton}
          >
            {mode === "password" ? "Sign in with email code" : "Sign in with password"}
          </button>
        </div>
      )}
    </div>
  );
}
