// The YC-intent marker: set the moment anyone lands on /signin?yc=1, cleared
// when the post-login YC surface actually renders. It exists so the $526
// claim cannot be silently skipped by a redirect slip — any auth path that
// bounces to the generic post-login landing instead of back to ?yc=1 (a
// regression the product owner hit live when a fold restored the pre-YC SigninForm) gets
// caught by the Overview's server guard and the sign-in success fallback,
// both keyed on this cookie. A cookie rather than localStorage because the
// Overview check is server-side; 30 minutes outlives any auth round-trip
// without lingering on the browser.

export const YC_INTENT_COOKIE = "explabs_yc_intent";

export function markYcIntent(): void {
  document.cookie = `${YC_INTENT_COOKIE}=1; path=/; max-age=1800; samesite=lax`;
}

export function clearYcIntent(): void {
  document.cookie = `${YC_INTENT_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

export function hasYcIntent(): boolean {
  return document.cookie.split("; ").includes(`${YC_INTENT_COOKIE}=1`);
}
