import type { NextRequest } from "next/server";

// Only same-origin absolute paths are allowed as post-auth redirect targets;
// anything else (external URLs, protocol-relative //host, empty) collapses to
// the app root. Backslashes are rejected because URL parsing normalizes them
// to slashes, turning "/\evil.example" into a protocol-relative redirect.
export function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/";
  }
  return value;
}

// The shape ordinary real addresses satisfy — enough to refuse garbage and
// markup without rejecting normal exotic addresses. Deliberately NOT an RFC
// validator: GoTrue decides what it accepts; this guards prefill rendering
// and request parsing.
const EMAIL_SHAPE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Sanitizes an email arriving from the outside (the ?email= prefill the
 * marketing site hands /signin, OTP request bodies): trimmed and
 * shape-checked, null for anything malformed so callers ignore it rather
 * than render or forward junk.
 */
export function safePrefillEmail(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.length > 254 || !EMAIL_SHAPE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * The origin the BROWSER is on, for building auth redirects, OAuth callback
 * URLs, and organization invite links. Behind the standalone server and an
 * ingress, `request.nextUrl.origin` is the bind address (http://0.0.0.0:3000),
 * not the public host; URLs built from it strand the browser on 0.0.0.0 and
 * hand GoTrue an off-allow-list callback. Prefer the proxy's forwarded
 * headers (first value only: proxies append, and a spoofed second entry must
 * not win), then the Host header the browser sent, then the bind origin as
 * the last resort. A malformed header falls back rather than throwing inside
 * an auth redirect.
 */
export function requestOrigin(request: NextRequest): string {
  const configuredOrigin = process.env.EXPLABS_WEBAPP_URL?.trim();
  if (configuredOrigin) {
    try {
      const url = new URL(configuredOrigin);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.origin;
      }
    } catch {
      // Fall through to the request headers. A bad deployment override must not
      // take down an otherwise usable auth redirect.
    }
  }
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  if (!host) {
    return request.nextUrl.origin;
  }
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : request.nextUrl.protocol.replace(":", "");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return request.nextUrl.origin;
  }
}
