/**
 * Intentionally renders nothing. OverviewView (client) already paints a PARTIAL
 * skeleton — the real page shell with Shimmer only on the data widgets — so a
 * full-page fallback here produced two skeletons (complete then partial). A
 * route loading.tsx is still required so the navigation Suspense boundary does
 * NOT fall through to the group fallback (app/(workspace)/loading.tsx) and flash
 * the generic card grid first. Returning null suppresses the full skeleton; the
 * page's fast auth/org awaits resolve, then only OverviewView's partial shows
 * (the product owner: keep the partial, drop the complete).
 */
export default function OverviewLoading() {
  return null;
}
