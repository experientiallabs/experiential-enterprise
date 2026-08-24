"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { recordAuthMethod } from "@/lib/auth/last-used";
import { overviewPath, signinPath } from "@/lib/routes";

const MIN_PASSWORD_LENGTH = 6;

// Dark (onboard) tone classes, matching AuthForm's `dark` tone so the two auth
// surfaces read as one.
const INPUT_CLASS =
  "w-full px-4 py-3 rounded-xl border border-white/20 bg-white/[0.08] text-sm text-onboard-text placeholder:text-onboard-muted/50 focus:outline-none focus:border-white/40 focus:shadow-[0_0_15px_rgba(255,255,255,0.05)] transition-all";
const LABEL_CLASS =
  "block text-[11px] font-semibold text-onboard-muted mb-2 uppercase tracking-[0.15em] font-mono";
const ERROR_CLASS =
  "px-4 py-3 rounded-xl bg-danger/10 border border-danger/20 text-sm text-danger";
const SUBMIT_CLASS =
  "relative w-full mt-2 px-6 py-3.5 rounded-full border border-transparent bg-onboard-text text-onboard-bg hover:bg-white font-semibold text-sm tracking-tight transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Sets a new password on the recovery session established by the emailed reset
 * link. Validates length and match client-side, then POSTs to
 * /auth/password/reset/confirm (which is recovery-session-gated). On success the
 * session is refreshed with the new credential and the user lands on the
 * Overview; a 401 means the recovery session lapsed, so it points back to /signin.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setIsSubmitting(true);
    try {
      let response: Response;
      try {
        response = await fetch("/auth/password/reset/confirm", {
          body: JSON.stringify({ password }),
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
        if (payload?.code === "no_recovery") {
          setExpired(true);
        }
        setError(
          typeof payload?.error === "string" ? payload.error : "Unable to set the password."
        );
        return;
      }
      recordAuthMethod("password");
      router.push(overviewPath());
      router.refresh();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div>
        <label htmlFor="reset-password" className={LABEL_CLASS}>
          New password
        </label>
        <input
          autoComplete="new-password"
          autoFocus
          id="reset-password"
          minLength={MIN_PASSWORD_LENGTH}
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="At least 6 characters"
          required
          type="password"
          value={password}
          className={INPUT_CLASS}
        />
      </div>
      <div>
        <label htmlFor="reset-password-confirm" className={LABEL_CLASS}>
          Confirm password
        </label>
        <input
          autoComplete="new-password"
          id="reset-password-confirm"
          minLength={MIN_PASSWORD_LENGTH}
          name="confirmPassword"
          onChange={(event) => setConfirm(event.target.value)}
          placeholder="Re-enter your password"
          required
          type="password"
          value={confirm}
          className={INPUT_CLASS}
        />
      </div>
      {error && (
        <div className={ERROR_CLASS}>
          {error}
          {expired && (
            <>
              {" "}
              <a href={signinPath()} className="underline">
                Back to sign in
              </a>
            </>
          )}
        </div>
      )}
      <button type="submit" disabled={isSubmitting} className={SUBMIT_CLASS}>
        {isSubmitting ? "Saving..." : "Set password"}
      </button>
    </form>
  );
}
