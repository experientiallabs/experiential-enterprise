"use client";

import { useEffect, useRef } from "react";

import { markYcIntent } from "@/components/yc/yc-intent";
import { captureTelemetryEvent } from "@/lib/telemetry/client";

/**
 * Funnel marker for the shared YC link: one `yc_offer_viewed` per mount of
 * the sign-in page's YC variant (docs/analytics.md naming). Pageviews are
 * captured automatically; this event exists so the funnel can key on the yc
 * param specifically. Also plants the YC-intent cookie so a post-auth
 * redirect slip cannot skip the claim (YcClaimRedirect clears it once the
 * claim is served — it mounts after this in the tree, so a signed-in render
 * nets to cleared).
 */
export function YcArrivalCapture({ signedIn }: { signedIn: boolean }) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) {
      return;
    }
    firedRef.current = true;
    markYcIntent();
    captureTelemetryEvent("yc_offer_viewed", { signed_in: signedIn });
  }, [signedIn]);
  return null;
}
