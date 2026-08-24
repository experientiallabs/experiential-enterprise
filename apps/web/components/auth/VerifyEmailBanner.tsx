"use client";

import { useState } from "react";

// Persistent prompt on the signed-in surface for a user whose email is not yet
// verified: their $20 credits are granted and visible but LOCKED until they
// verify, so this makes the one required action obvious instead of surfacing it
// only when a spend is refused. Resend sends the verification link again.
export function VerifyEmailBanner({ email }: { email: string | null }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");

  async function resend(): Promise<void> {
    setState("sending");
    try {
      await fetch("/auth/resend-verification", { method: "POST" });
    } catch {
      // Neutral: the banner stays up regardless; the user can retry.
    } finally {
      setState("sent");
    }
  }

  // Tasteful by direction (the product owner, 2026-08-22): a quiet full-width strip, no
  // border and no em dash — the copy stays short and the action stays one
  // small button.
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 bg-warning-soft px-4 py-2 text-[13px] text-ink">
      <p className="m-0">
        <span className="font-medium">Verify your email to use your credits.</span>{" "}
        {email ? `We sent a link to ${email}.` : "We sent you a verification link."} Everything
        else already works.
      </p>
      <button
        type="button"
        disabled={state === "sending"}
        onClick={() => void resend()}
        className="shrink-0 rounded-full border border-line bg-background px-3 py-1 text-[12px] font-semibold text-ink hover:bg-hover transition-colors disabled:opacity-50"
      >
        {state === "sending" ? "Sending..." : state === "sent" ? "Link resent" : "Resend link"}
      </button>
    </div>
  );
}
