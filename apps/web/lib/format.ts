import type { ChipTone } from "@/components/ui/Chip";

import type { ProviderConnectionStatus } from "./model-providers";
import type { BuildJobStatus, GatewayRequestStatus, WorldModelStatus } from "./types";

// World-model lifecycle chips: "ready" is green (the model can serve),
// "building" pulses gray like any in-flight state, "created" is the light
// queued gray, "failed" is red.
const WORLD_MODEL_STATUS_TONE: Record<WorldModelStatus, ChipTone> = {
  created: "queued",
  building: "running",
  ready: "passed",
  failed: "failed"
};

export function worldModelStatusTone(status: WorldModelStatus): ChipTone {
  return WORLD_MODEL_STATUS_TONE[status];
}

export function worldModelStatusLabel(status: WorldModelStatus): string {
  switch (status) {
    case "created":
      return "Created";
    case "building":
      // The customer word for a simulation being learned (the product owner, 2026-07-30).
      return "Training";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

// Build jobs: "completed" is blue (finished, not an improvement signal per the
// design system), claimed/running pulse, failures are red, stalled is treated
// as a terminal failure (heartbeat timed out without a final status).
const BUILD_JOB_STATUS_TONE: Record<BuildJobStatus, ChipTone> = {
  queued: "queued",
  claimed: "running",
  running: "running",
  completed: "complete",
  failed: "failed",
  stalled: "failed",
  cancelled: "queued",
  paused: "queued"
};

export function buildJobStatusTone(status: BuildJobStatus): ChipTone {
  return BUILD_JOB_STATUS_TONE[status];
}

export function buildJobStatusLabel(status: BuildJobStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "claimed":
      return "Claimed";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stalled":
      return "Stalled";
    case "cancelled":
      return "Stopped";
    case "paused":
      return "Paused";
  }
}

// Provider-key connection states (the canonical six from lib/model-providers).
// A rejected credential and an exhausted quota are hard failures (requests on
// this key fail) and read red — deliberately NOT the amber `invalid` tone,
// which is the simulations' "not a valid measurement". Rate limiting is amber:
// the key works, the provider is throttling. A provider_error means OUR check
// failed to reach the provider, not that their key is bad, so it stays a
// muted gray rather than a verdict color; unchecked is the lighter queued gray.
const PROVIDER_CONNECTION_STATUS_TONE: Record<ProviderConnectionStatus, ChipTone> = {
  unchecked: "queued",
  valid: "passed",
  invalid: "failed",
  rate_limited: "rate_limited",
  quota_exhausted: "failed",
  provider_error: "cancelled"
};

export function providerConnectionStatusTone(status: ProviderConnectionStatus): ChipTone {
  return PROVIDER_CONNECTION_STATUS_TONE[status];
}

export function providerConnectionStatusLabel(status: ProviderConnectionStatus): string {
  switch (status) {
    case "unchecked":
      return "Not verified";
    case "valid":
      return "Verified";
    case "invalid":
      return "Invalid key";
    case "rate_limited":
      return "Rate limited";
    case "quota_exhausted":
      return "Out of quota";
    case "provider_error":
      return "Provider error";
  }
}

/**
 * Gateway request terminal states, for the Telemetry request log. Everything
 * except `completed` counts as an error in the aggregates, so the log labels
 * each terminal state precisely instead of a bare "Error".
 */
export function gatewayRequestStatusLabel(status: GatewayRequestStatus): string {
  switch (status) {
    case "completed":
      return "OK";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "incomplete":
      return "Incomplete";
    case "expired_before_dispatch":
      return "Expired";
    case "unknown_after_crash":
      return "Unknown";
  }
}

/**
 * Why a non-OK gateway request ended, for the request log. Prefers the
 * sanitized upstream reason the gateway recorded; otherwise explains the
 * terminal state itself (WMO exposes no finer finish reason than the status).
 * Returns null for a completed request — there is no failure to explain.
 */
export function gatewayRequestOutcomeReason(
  status: GatewayRequestStatus,
  errorMessage: string | null
): string | null {
  if (status === "completed") {
    return null;
  }
  if (errorMessage !== null && errorMessage.trim().length > 0) {
    return errorMessage;
  }
  switch (status) {
    case "incomplete":
      return "The response ended before completion (truncated, or the token limit was reached).";
    case "cancelled":
      return "The request was cancelled before it finished.";
    case "expired_before_dispatch":
      return "The request expired before it could reach a provider.";
    case "unknown_after_crash":
      return "The outcome is unknown — the worker handling this request stopped before it settled.";
    case "failed":
      return "The request failed upstream.";
  }
}

export function formatScore(value: number): string {
  return value.toFixed(2);
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Compact token count for card stat lines: 812, 24.6k, 1.2M. */
export function formatTokens(value: number): string {
  if (value < 1_000) {
    return `${value}`;
  }
  if (value < 1_000_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// The date formatters pin the locale and require an explicit IANA zone so the
// rendered text is deterministic: server HTML and the hydration render must
// agree (React #418). Client components obtain the zone via useDisplayTimeZone,
// which yields "UTC" until hydration completes and the viewer's zone after.
// Formatter construction costs ~10-100µs and only two zones occur per page
// (UTC and the viewer's), so instances are cached per option shape and zone.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

export function formatDateTime(value: string, timeZone: string): string {
  return cachedFormatter(`datetime|${timeZone}`, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone
  }).format(new Date(value));
}

/** Year-bearing variant for provenance fields where staleness must be visible. */
export function formatDateTimeWithYear(value: string, timeZone: string): string {
  return cachedFormatter(`datetime-year|${timeZone}`, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone
  }).format(new Date(value));
}

/** Date-only variant for deadlines ("expires Nov 19, 2026"), no clock time. */
export function formatDateWithYear(value: string, timeZone: string): string {
  return cachedFormatter(`date-year|${timeZone}`, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone
  }).format(new Date(value));
}

export function formatClockTime(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return cachedFormatter(`clock|${timeZone}`, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone
  }).format(date);
}

/**
 * The slug rule world-model names follow (the backend enforces the same);
 * shared here so every surface that validates a name reads one pattern.
 */
export const WORLD_MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9\-_]*$/;

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
