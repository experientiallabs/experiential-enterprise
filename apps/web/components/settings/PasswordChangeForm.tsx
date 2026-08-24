"use client";

import { type FormEvent, useState } from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/Button";

const LABEL_CLASS =
  "block m-0 mb-1.5 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase";
const INPUT_CLASS =
  "w-full min-h-[38px] rounded-[var(--radius-md)] border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-muted-2 focus:outline-none focus:border-ink/30";

type PasswordFormMode = "change" | "set";

/**
 * `change` proves the current password before replacing it; `set` is the
 * first password for a passwordless (email-code) account — there is nothing
 * to prove, the emailed code keeps working, and the form simply omits the
 * current-password field (the route only honors that for a verifiably
 * passwordless account).
 */
export function PasswordChangeForm({ mode = "change" }: { mode?: PasswordFormMode }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSet = mode === "set";

  const canSubmit =
    (isSet || currentPassword.length > 0) &&
    newPassword.length >= 6 &&
    confirmPassword.length >= 6 &&
    !isSubmitting;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    if (newPassword !== confirmPassword) {
      setError("New password and confirmation must match.");
      return;
    }
    if (!isSet && newPassword === currentPassword) {
      setError("New password must be different from your current password.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/auth/password", {
        body: JSON.stringify({
          currentPassword: isSet ? null : currentPassword,
          newPassword,
          confirmPassword
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (!response.ok) {
        setError(typeof payload?.error === "string" ? payload.error : "Unable to update password.");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice(isSet ? "Password set. Your emailed sign-in code keeps working too." : "Password updated.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form
      aria-label={isSet ? "Set password" : "Change password"}
      className="flex flex-col gap-4"
      onSubmit={submit}
    >
      <div className="grid gap-3 lg:grid-cols-3">
        {!isSet && (
          <div>
            <label className={LABEL_CLASS} htmlFor="current-password">
              Current password
            </label>
            <input
              autoComplete="current-password"
              className={INPUT_CLASS}
              id="current-password"
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              type="password"
              value={currentPassword}
            />
          </div>
        )}
        <div>
          <label className={LABEL_CLASS} htmlFor="new-password">
            New password
          </label>
          <input
            autoComplete="new-password"
            className={INPUT_CLASS}
            id="new-password"
            minLength={6}
            onChange={(event) => setNewPassword(event.target.value)}
            required
            type="password"
            value={newPassword}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="confirm-password">
            Confirm password
          </label>
          <input
            autoComplete="new-password"
            className={INPUT_CLASS}
            id="confirm-password"
            minLength={6}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
            type="password"
            value={confirmPassword}
          />
        </div>
      </div>

      {error ? (
        <p
          aria-live="polite"
          className="m-0 rounded-[var(--radius-md)] border border-danger bg-danger-soft px-3 py-2.5 text-danger text-[13px]"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          aria-live="polite"
          className="m-0 rounded-[var(--radius-md)] border border-success bg-success-soft px-3 py-2.5 text-success text-[13px]"
        >
          {notice}
        </p>
      ) : null}

      <div className="flex items-center justify-end">
        <Button disabled={!canSubmit} type="submit" variant="primary">
          <KeyRound aria-hidden size={15} strokeWidth={1.8} />
          {isSubmitting
            ? isSet
              ? "Setting..."
              : "Updating..."
            : isSet
              ? "Set password"
              : "Update password"}
        </Button>
      </div>
    </form>
  );
}
