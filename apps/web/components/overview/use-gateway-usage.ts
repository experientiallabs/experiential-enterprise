"use client";

// The Overview's client reads: plain fetch + effect state, matching the
// repo's no-client-data-library stance. The all-time per-day series is
// fetched once per scope and every period/metric derivation happens in pure
// lib/gateway-usage math, so toggles re-render instantly and consistently;
// only the grouped rollups (top models, per-member) refetch per period.

import { useEffect, useState } from "react";

import type {
  GatewayUsageGroupBy,
  GatewayUsageRow,
  GatewayUsageScope,
  PlatformUsageGroupBy
} from "@/lib/gateway-usage";

export type UsageRowsSnapshot<Row> = {
  /**
   * The latest good rows; stays rendered while a refresh is in flight and is
   * dropped when that refresh fails.
   */
  rows: Row[] | null;
  error: string | null;
  loading: boolean;
  /**
   * The url the current rows/error belong to (null while idle or before the
   * first load lands). A caller that changes the url can gate on
   * `forUrl === <the url it just passed>` to avoid rendering the previous
   * url's rows under the new query's label for the render before the effect
   * flips `loading` (Overview/Telemetry ignore this and keep prior rows on a
   * switch, which is their intended feel).
   */
  forUrl: string | null;
};

export type UsageSnapshot = UsageRowsSnapshot<GatewayUsageRow>;

export type GatewayUsageQuery = {
  orgId: string;
  scope: GatewayUsageScope;
  groupBy: GatewayUsageGroupBy;
  /** Inclusive UTC day bounds; omit both for all-time. */
  from?: string;
  to?: string;
};

/**
 * Read one `{ rows }` usage payload from a rollup endpoint; a null url stays
 * idle (no fetch fires). The row shape is the caller's contract with its
 * endpoint: the Overview reads per-org rows, the admin Telemetry panel reads
 * platform-wide rows through the same state machine. Passing `pollIntervalMs`
 * re-reads the same url on that interval (silent refresh: `loading` stays
 * false and the previous rows stay rendered until the new ones land) so a
 * left-open surface does not freeze at its mount-time snapshot.
 */
export function useUsageRows<Row>(
  url: string | null,
  pollIntervalMs?: number
): UsageRowsSnapshot<Row> {
  const idle: UsageRowsSnapshot<Row> = { rows: null, error: null, loading: false, forUrl: null };
  const [snapshot, setSnapshot] = useState<UsageRowsSnapshot<Row>>(idle);

  // The effect keys on the url string, so object identity churn from
  // re-renders never refetches.
  useEffect(() => {
    if (url === null) {
      setSnapshot({ rows: null, error: null, loading: false, forUrl: null });
      return;
    }
    let cancelled = false;
    setSnapshot((previous) => ({ ...previous, loading: true }));
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error ?? `Usage read failed (${response.status})`);
        }
        const payload = (await response.json()) as { rows: Row[] };
        if (!cancelled) {
          setSnapshot({ rows: payload.rows, error: null, loading: false, forUrl: url });
        }
      } catch (error) {
        if (!cancelled) {
          // Drop the previous rows: they answer the previous url's query (its
          // own period and scope), so stranding them would render one
          // period's usage under another's label. The error renders instead.
          setSnapshot({
            rows: null,
            error: error instanceof Error ? error.message : "The usage read failed.",
            loading: false,
            forUrl: url
          });
        }
      }
    };
    void load();
    const timer =
      pollIntervalMs === undefined ? undefined : setInterval(() => void load(), pollIntervalMs);
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearInterval(timer);
      }
    };
  }, [url, pollIntervalMs]);

  return snapshot;
}

/** Read one grouped usage rollup; a null query stays idle (no fetch fires). */
export function useGatewayUsage(query: GatewayUsageQuery | null): UsageSnapshot {
  return useUsageRows<GatewayUsageRow>(
    query === null ? null : `/api/gateway/usage/daily?${usageQueryString(query)}`
  );
}

/**
 * Url for the platform-wide admin usage rollup; shared by every admin surface
 * that reads it (Telemetry panel, Organizations browse) so the query contract
 * has one spelling. `group_by` stays the first-inserted param — tests assert
 * on the `?group_by=` prefix.
 */
export function platformUsageUrl(query: {
  groupBy: PlatformUsageGroupBy;
  from?: string;
  to?: string;
}): string {
  const params = new URLSearchParams({ group_by: query.groupBy });
  if (query.from !== undefined) {
    params.set("from", query.from);
  }
  if (query.to !== undefined) {
    params.set("to", query.to);
  }
  return `/api/admin/telemetry/usage?${params.toString()}`;
}

export function usageQueryString(query: GatewayUsageQuery): string {
  const params = new URLSearchParams({
    org: query.orgId,
    scope: query.scope,
    group_by: query.groupBy
  });
  if (query.from !== undefined) {
    params.set("from", query.from);
  }
  if (query.to !== undefined) {
    params.set("to", query.to);
  }
  return params.toString();
}

export type MemberDirectory = Map<string, string>;

/**
 * user_id → email for the workspace member breakdown; null org stays idle.
 * Every member may read the roster, but only the workspace scope (admins)
 * mounts this.
 */
export function useMemberDirectory(orgId: string | null): MemberDirectory | null {
  const [directory, setDirectory] = useState<MemberDirectory | null>(null);

  useEffect(() => {
    if (orgId === null) {
      setDirectory(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/members`, {
          cache: "no-store"
        });
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as {
          members?: { userId: string; email: string | null }[];
        };
        if (!cancelled && payload.members) {
          setDirectory(
            new Map(
              payload.members
                .filter((member) => member.email !== null)
                .map((member) => [member.userId, member.email as string])
            )
          );
        }
      } catch {
        // The breakdown falls back to raw member ids; no error surface needed.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return directory;
}
