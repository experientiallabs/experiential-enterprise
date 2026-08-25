"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { readApiError } from "@/components/world-models/wm-client";
import type { JoinOffer } from "@/lib/org-join/types";

/**
 * Post-signup prompt shown when the signed-in user's email domain matches an
 * existing organization they do not yet belong to: "Request access to <Org>".
 * Their own personal org is untouched; this only asks to join the matched org.
 *
 * The request stays gated to a verified email (the button is disabled and
 * explains why until then) and the backend re-enforces every rule.
 */
export function RequestAccessBanner({ offer }: { offer: JoinOffer }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The parent only renders this for a non-member offer, but guard anyway so
  // the component is safe to drop anywhere.
  if (offer.already_member) {
    return null;
  }

  async function requestAccess() {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/join-requests", { method: "POST" });
      if (!response.ok) {
        setError(await readApiError(response, "Could not request access."));
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-line-strong bg-surface-subtle p-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="m-0 text-[13px] leading-relaxed text-ink">
        Your email domain matches <span className="font-medium">{offer.org_name}</span>.
        {offer.request_status === "pending"
          ? " Access requested, an admin of the organization will review it."
          : offer.email_verified
            ? " Request access to join it."
            : " Verify your email to request access."}
      </p>
      {offer.request_status === "pending" ? (
        <span className="text-[12px] text-muted">Pending review</span>
      ) : (
        <Button
          onClick={requestAccess}
          disabled={busy || !offer.email_verified}
          loading={busy}
          size="sm"
        >
          {`Request access to ${offer.org_name}`}
        </Button>
      )}
      {error ? <p className="m-0 text-[12px] text-red-600">{error}</p> : null}
    </div>
  );
}
