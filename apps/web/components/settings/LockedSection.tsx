"use client";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { Button } from "@/components/ui/Button";

type LockedSectionProps = {
  /** One line saying what lives here, e.g. "API keys for calling the gateway." */
  description: string;
};

/**
 * The shared signed-out locked-state card (docs/design-system.md "Gating
 * patterns"): account-scoped content areas render this instead of fetching
 * data or hand-rolling padlocks. The frame around it — page, nav, headings —
 * still renders; only the content is behind the sign-in. Consumed by the
 * settings sections (shell-P9) and any personal panel other workstreams gate.
 */
export function LockedSection({ description }: LockedSectionProps) {
  const { open } = useLoginModal();
  return (
    <section
      className="flex flex-col items-start gap-4 rounded-[var(--radius-lg)] border border-line bg-surface p-[18px]"
      data-testid="locked-section"
    >
      <p className="m-0 text-[13px] leading-relaxed text-muted">{description}</p>
      <Button onClick={open} size="sm" type="button" variant="primary">
        Sign in
      </Button>
    </section>
  );
}
