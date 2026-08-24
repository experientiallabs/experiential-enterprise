"use client";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { buttonClassName } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";

/**
 * The signed-out page header affordance: an unmissable "Demo data" chip next
 * to the one CTA that swaps in real usage. Lives inline in the header row so
 * signing in removes it without shifting the sections below.
 */
export function DemoBanner() {
  const loginModal = useLoginModal();
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <Chip label="Demo data" tone="future" />
      <button
        className={buttonClassName("accent", undefined, "sm")}
        onClick={() => loginModal.open()}
        type="button"
      >
        Log in to see your usage
      </button>
    </div>
  );
}
