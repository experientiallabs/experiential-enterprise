import type { AuthenticatedUser } from "@/lib/auth/claims";

// Typed boundary over product telemetry. This trial distribution ships
// telemetry-dark: no telemetry SDK is imported, so none lands in the built
// bundle, and every entry point below is a documented no-op. Call sites stay
// unchanged so the trial UI code matches the product exactly.

/** Initialize the telemetry client; a no-op in this telemetry-dark build. */
export function initTelemetry(): void {}

/** The workspace an identified session is operating in, for person properties. */
export type TelemetryOrg = {
  slug: string;
  name: string;
};

/** Mirror auth state into the telemetry session; a no-op in this build. */
export function syncTelemetryIdentity(
  _user: AuthenticatedUser | null,
  _org: TelemetryOrg | null = null
): void {}

/** Capture a product event; a no-op in this telemetry-dark build. */
export function captureTelemetryEvent(
  _event: string,
  _properties?: Record<string, string | number | boolean | null>
): void {}
