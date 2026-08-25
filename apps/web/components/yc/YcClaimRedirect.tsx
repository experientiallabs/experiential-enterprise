"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { clearYcIntent } from "@/components/yc/yc-intent";
import { overviewWelcomePath } from "@/lib/routes";

/**
 * The signed-in YC arrival: there is no bespoke YC page anymore. Logging in
 * through /yc IS the claim, so this fires it once and drops the founder into
 * the app, where the standard welcome-celebration modal greets them (branded
 * for YC by the org's `yc` tag). It applies the $526 launch grant + tag
 * (idempotent — a duplicate answers 409), clears the yc-intent cookie so the
 * Overview guard does not bounce a served claim, and redirects to the welcome
 * landing. A failed claim leaves the cookie so the guard can retry.
 */
export function YcClaimRedirect() {
  const router = useRouter();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    void (async () => {
      const orgId = await readActiveOrgId();
      if (orgId !== null) {
        const claimed = await claimYcGrant(orgId);
        if (claimed) {
          clearYcIntent();
        }
      }
      router.replace(overviewWelcomePath());
    })();
  }, [router]);

  return (
    <div
      className="flex flex-col items-center gap-3 py-10 text-center"
      data-testid="yc-claim-redirect"
    >
      <div
        aria-hidden
        className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-ink"
      />
      <p className="m-0 text-sm text-muted">Applying your YC deal…</p>
    </div>
  );
}

/** The active org id from the welcome read, or null if nothing resolves. */
async function readActiveOrgId(): Promise<string | null> {
  try {
    const response = await fetch("/api/welcome", { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json().catch(() => null)) as {
      org?: { id?: unknown };
    } | null;
    return typeof payload?.org?.id === "string" ? payload.org.id : null;
  } catch {
    return null;
  }
}

/** Apply the YC launch grant + tag; true when served (200 or an idempotent 409). */
async function claimYcGrant(orgId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/yc/claim`, {
      method: "POST"
    });
    return response.ok || response.status === 409;
  } catch {
    return false;
  }
}
