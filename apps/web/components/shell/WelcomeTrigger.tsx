"use client";

import { useEffect, useRef, useState } from "react";

import { WelcomeCelebration } from "@/components/auth/WelcomeCelebration";
import { fetchWelcomeData } from "@/components/auth/welcome-data";
import { claimWelcomeTrigger } from "@/lib/welcome-trigger";

type Ready = {
  displayCreditUsd: number | null;
  apiKey: string | null;
  showApiKey: boolean;
  isYcCompany: boolean;
};

/**
 * The re-triggerable welcome celebration (the product owner, 2026-08-24): the SAME confetti
 * + integration-prompt modal the first-key reveal shows, but re-armed by a
 * platform admin per org (or label cohort). Mounted once in the signed-in shell,
 * it asks the server on first render whether this user should celebrate now and,
 * if so, shows the modal exactly once — the server advances the user's seen
 * marker in the same claim, so it never repeats until an admin re-arms it.
 *
 * When the admin left the API key on, it surfaces the org's key via the same
 * mint-if-none read the first-key reveal uses; an org that already holds keys
 * (the common re-trigger case) has no retrievable secret, so the modal degrades
 * to the announced credits + copy-paste prompts rather than showing a key it
 * cannot reveal. Any failure resolves to showing nothing.
 *
 * Keyed on `activeOrgId`: App Router keeps this layout (and this component)
 * mounted across a soft org-switch, so the claim must re-run when the active org
 * changes — otherwise a member switching to a freshly-armed org would not see
 * the celebration until a hard reload. The claim itself stays exactly-once per
 * org (the server advances the seen marker atomically).
 */
export function WelcomeTrigger({
  activeOrgId,
  webBaseUrl,
  apiBaseUrl
}: {
  activeOrgId: string;
  webBaseUrl: string;
  apiBaseUrl: string;
}) {
  const [ready, setReady] = useState<Ready | null>(null);
  // The org whose claim has already fired, so a re-render can never spend a
  // second claim for the same org; it re-arms only when the active org changes.
  const claimedOrgRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (claimedOrgRef.current === activeOrgId) {
      return;
    }
    claimedOrgRef.current = activeOrgId;
    // Clear any prior org's modal before deciding the new org's celebration.
    setReady(null);
    void (async () => {
      const claim = await claimWelcomeTrigger();
      if (!mountedRef.current || claimedOrgRef.current !== activeOrgId || !claim.show) {
        return;
      }
      // Only reach for a key when the admin opted in; otherwise skip the read
      // entirely (no mint) and show the credits + prompts alone. On a re-trigger
      // we force a FRESH mint so every member sees a usable key, even one whose
      // org already holds a (hash-stored, unshowable) key.
      const apiKey = claim.showApiKey ? (await fetchWelcomeData(true))?.mintedSecret ?? null : null;
      if (!mountedRef.current || claimedOrgRef.current !== activeOrgId) {
        return;
      }
      setReady({
        displayCreditUsd: claim.displayCreditUsd,
        apiKey,
        showApiKey: claim.showApiKey,
        isYcCompany: claim.isYcCompany
      });
    })();
  }, [activeOrgId]);

  if (ready === null) {
    return null;
  }

  return (
    <WelcomeCelebration
      grantedUsd={ready.displayCreditUsd}
      apiKey={ready.apiKey}
      showApiKey={ready.showApiKey}
      webBaseUrl={webBaseUrl}
      apiBaseUrl={apiBaseUrl}
      variant={ready.isYcCompany ? "yc" : undefined}
      onClose={() => setReady(null)}
    />
  );
}
