import type {
  ServingBucket,
  ServingRequestCursor,
  ServingRequestStatus,
  ServingWindow
} from "./types";

// Pure helpers behind the legacy serving views (the Project page's Telemetry
// tab and usage charts): query-string construction for the serving proxy
// routes, chart gap-filling, and display formatting. Kept free of React so
// the unit suite can pin the semantics. The org-wide Telemetry page reads the
// gateway ledger through lib/gateway-telemetry.ts instead.

export const SERVING_WINDOWS: { key: ServingWindow; label: string }[] = [
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" }
];

const WINDOW_KEYS: ServingWindow[] = ["24h", "7d", "30d"];

export const DEFAULT_SERVING_WINDOW: ServingWindow = "7d";

// One page of the request table; the server page and the client view must
// agree or the first "Load more" duplicates or skips rows.
export const SERVING_PAGE_SIZE = 50;

export type ServingRequestQuery = {
  endpoint?: string;
  status?: ServingRequestStatus;
  window?: ServingWindow;
  cursor?: ServingRequestCursor;
  limit?: number;
};

/** Build the query string the serving proxy routes (and backend) accept. */
export function servingRequestQueryString(query: ServingRequestQuery): string {
  const params = new URLSearchParams();
  if (query.endpoint) {
    params.set("endpoint", query.endpoint);
  }
  if (query.status) {
    params.set("status", query.status);
  }
  if (query.window) {
    params.set("window", query.window);
  }
  if (query.cursor) {
    params.set("cursor_ts", query.cursor.ts);
    params.set("cursor_id", query.cursor.id);
    params.set("cursor_after", query.cursor.after);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  return params.toString();
}

/** Parse a proxy route's incoming search params back into a request query. */
export function servingRequestQueryFromSearchParams(params: URLSearchParams): ServingRequestQuery {
  const query: ServingRequestQuery = {};
  const endpoint = params.get("endpoint");
  if (endpoint) {
    query.endpoint = endpoint;
  }
  const status = params.get("status");
  if (status === "ok" || status === "error") {
    query.status = status;
  }
  const window = params.get("window");
  if (WINDOW_KEYS.includes(window as ServingWindow)) {
    query.window = window as ServingWindow;
  }
  const cursorTs = params.get("cursor_ts");
  const cursorId = params.get("cursor_id");
  const cursorAfter = params.get("cursor_after");
  if (cursorTs && cursorId && cursorAfter) {
    query.cursor = { ts: cursorTs, id: cursorId, after: cursorAfter };
  }
  const limit = params.get("limit");
  if (limit && /^\d+$/.test(limit)) {
    query.limit = Number(limit);
  }
  return query;
}

// The serving view's in-memory state. It was once URL-persisted from
// /telemetry; the view now renders only inside the Project page's Telemetry
// tab, which pins the endpoint and keeps the host page's URL untouched.
export type ServingViewState = {
  window: ServingWindow;
  endpointId: string | null;
  errorsOnly: boolean;
  live: boolean;
};

export const DEFAULT_SERVING_VIEW: ServingViewState = {
  window: DEFAULT_SERVING_WINDOW,
  endpointId: null,
  errorsOnly: false,
  live: false
};

/**
 * Expand sparse buckets into a contiguous series covering the whole window,
 * so the activity chart shows quiet periods as gaps instead of collapsing
 * the axis to only the buckets that had traffic.
 */
export function fillServingBuckets(
  buckets: ServingBucket[],
  bucketSeconds: number,
  windowKey: ServingWindow,
  nowMs: number
): ServingBucket[] {
  const windowSeconds = { "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400 }[windowKey];
  const stepMs = bucketSeconds * 1000;
  const endMs = Math.floor(nowMs / stepMs) * stepMs;
  const startMs = Math.floor((nowMs - windowSeconds * 1000) / stepMs) * stepMs;
  const byStart = new Map<number, ServingBucket>();
  for (const bucket of buckets) {
    byStart.set(Date.parse(bucket.bucket_start), bucket);
  }
  const filled: ServingBucket[] = [];
  for (let at = startMs; at <= endMs; at += stepMs) {
    filled.push(
      byStart.get(at) ?? {
        bucket_start: new Date(at).toISOString(),
        request_count: 0,
        error_count: 0
      }
    );
  }
  return filled;
}


/** Latency display: milliseconds under a second, seconds above. */
export function formatLatencyMs(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) {
    return "—";
  }
  const rounded = Math.round(value);
  if (rounded < 1000) {
    return `${rounded}ms`;
  }
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}
