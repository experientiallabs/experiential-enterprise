"use client";

import { Sparkles } from "lucide-react";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { buttonClassName } from "@/components/ui/Button";

/**
 * The signed-out Insights body. Insights query an account's OWN usage, so the
 * content is account-scoped: the frame renders, and the content area is one
 * quiet sign-in card (the design system's locked-section pattern) rather than a
 * demo. No account-scoped fetch fires while signed out.
 */
export function InsightsLocked() {
  const loginModal = useLoginModal();
  return (
    <section className="grid min-h-[280px] place-items-center rounded-[var(--radius-lg)] border border-line bg-surface p-8 text-center">
      <div className="flex max-w-[420px] flex-col items-center gap-3">
        <Sparkles aria-hidden className="text-accent" size={22} strokeWidth={1.6} />
        <h2 className="m-0 text-sm font-semibold text-ink">Query your own usage</h2>
        <p className="m-0 text-[13px] leading-relaxed text-muted">
          Ask plain-language questions about your gateway spend, requests, and errors, and see
          usage-tied suggestions. Sign in to explore your organization&apos;s Insights.
        </p>
        <button
          className={buttonClassName("primary", undefined, "sm")}
          onClick={() => loginModal.open()}
          type="button"
        >
          Sign in
        </button>
      </div>
    </section>
  );
}
