export type PostHogSettings = {
  key: string;
  host: string;
};

/**
 * Resolve the PostHog client settings for this build, or null when telemetry
 * is off. This trial distribution ships telemetry-dark: no project key is
 * bundled, this resolver is unconditionally null, and the telemetry client
 * itself imports no SDK at all, so no product telemetry leaves the deployment.
 */
export function resolvePostHogSettings(): PostHogSettings | null {
  return null;
}
