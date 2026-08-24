"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { ErrorTile } from "@/components/ui/ErrorTile";
import { LocalDateTime } from "@/components/ui/LocalDateTime";
import { Shimmer } from "@/components/ui/Shimmer";
import { readApiError } from "@/components/world-models/wm-client";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  type AuditLogEvent,
  type AuditLogList
} from "@/lib/audit-log";

type AuditLogPanelProps = {
  orgId: string;
};

// One newest-first page per request (the backend clamps at 200); a full page
// is the "there may be older events" signal for the load-older cursor.
const PAGE_LIMIT = 50;

function listUrl(
  orgId: string,
  filters: { action: string; objectType: string },
  before: string | null
): string {
  const params = new URLSearchParams();
  if (filters.action.length > 0) {
    params.set("action", filters.action);
  }
  if (filters.objectType.length > 0) {
    params.set("object_type", filters.objectType);
  }
  if (before !== null) {
    params.set("before", before);
  }
  params.set("limit", String(PAGE_LIMIT));
  return `/api/orgs/${encodeURIComponent(orgId)}/audit-log?${params.toString()}`;
}

/** Admin surface: who did what, to what, when — with filters and a CSV export. */
export function AuditLogPanel({ orgId }: AuditLogPanelProps) {
  const [action, setAction] = useState("");
  const [objectType, setObjectType] = useState("");
  const [events, setEvents] = useState<AuditLogEvent[] | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Bumped by the ErrorTile's retry so the initial-load effect re-runs.
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    (async () => {
      try {
        const response = await fetch(listUrl(orgId, { action, objectType }, null));
        if (!response.ok) {
          if (!cancelled) {
            setError(await readApiError(response, "Could not load the audit log."));
          }
          return;
        }
        const payload = (await response.json()) as AuditLogList;
        if (!cancelled) {
          setEvents(payload.events);
          setHasOlder(payload.events.length >= PAGE_LIMIT);
        }
      } catch {
        if (!cancelled) {
          setError("Could not load the audit log.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, action, objectType, retryToken]);

  // Page backwards through time: the oldest loaded event's timestamp is the
  // exclusive upper bound of the next page.
  async function loadOlder(): Promise<void> {
    if (events === null || events.length === 0 || isLoading) {
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const before = events[events.length - 1].created_at;
      const response = await fetch(listUrl(orgId, { action, objectType }, before));
      if (!response.ok) {
        setError(await readApiError(response, "Could not load older events."));
        return;
      }
      const payload = (await response.json()) as AuditLogList;
      setEvents([...events, ...payload.events]);
      setHasOlder(payload.events.length >= PAGE_LIMIT);
    } catch {
      setError("Could not load older events.");
    } finally {
      setIsLoading(false);
    }
  }

  const csvParams = new URLSearchParams();
  if (action.length > 0) {
    csvParams.set("action", action);
  }
  if (objectType.length > 0) {
    csvParams.set("object_type", objectType);
  }
  csvParams.set("format", "csv");
  const csvUrl = `/api/orgs/${encodeURIComponent(orgId)}/audit-log?${csvParams.toString()}`;

  // A failed FIRST load has nothing else to show: the ErrorTile with a retry
  // is the whole body. A failure after data is on screen renders as a quiet
  // inline strip beside the kept rows (matching the keys section's treatment).
  if (events === null && error !== null && !isLoading) {
    return (
      <ErrorTile
        title="Couldn't load the audit log"
        message={error}
        onRetry={() => setRetryToken((token) => token + 1)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error !== null && events !== null ? (
        <p className="m-0 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-danger text-[13px]">
          {error}
        </p>
      ) : null}

      <section className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.04em] text-foreground/40">
          Action
          <Dropdown
            aria-label="Filter by action"
            onChange={(event) => setAction(event.target.value)}
            value={action}
          >
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Dropdown>
        </label>
        <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.04em] text-foreground/40">
          Object type
          <Dropdown
            aria-label="Filter by object type"
            onChange={(event) => setObjectType(event.target.value)}
            value={objectType}
          >
            <option value="">All object types</option>
            {AUDIT_OBJECT_TYPES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Dropdown>
        </label>
        <a
          className="ml-auto inline-flex items-center rounded-md border border-line-strong bg-surface px-3 py-1.5 text-[12px] font-medium text-ink no-underline hover:bg-hover"
          download
          href={csvUrl}
        >
          Download CSV
        </a>
      </section>

      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        {isLoading && events === null ? (
          <div className="flex flex-col gap-3 p-[18px]">
            <Shimmer className="h-4 w-full" />
            <Shimmer className="h-4 w-full" />
            <Shimmer className="h-4 w-2/3" />
          </div>
        ) : events === null || events.length === 0 ? (
          <p className="m-0 px-4 py-6 text-center text-muted text-[13px]">
            No audit events{action || objectType ? " match these filters" : " yet"}. Administrative
            actions (key management, membership, billing settings) appear here as they happen.
          </p>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.04em] text-foreground/25">
                <th className="px-4 py-2 font-medium">Time</th>
                <th className="px-4 py-2 font-medium">Actor</th>
                <th className="px-4 py-2 font-medium">Action</th>
                <th className="px-4 py-2 font-medium">Object</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <AuditRow key={event.event_id} event={event} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {hasOlder ? (
        <div className="flex justify-center">
          <Button disabled={isLoading} onClick={() => void loadOlder()} size="sm">
            {isLoading ? "Loading…" : "Load older events"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AuditRow({ event }: { event: AuditLogEvent }) {
  return (
    <tr className="border-b border-line/60 align-middle">
      <td className="whitespace-nowrap px-4 py-2 text-ink">
        <LocalDateTime value={event.created_at} />
      </td>
      <td className="px-4 py-2">
        <span className="font-mono text-[12px] text-ink">{event.actor_id ?? "—"}</span>{" "}
        <span className="text-muted-2 text-[11px]">({event.actor_kind})</span>
      </td>
      <td className="px-4 py-2 font-medium text-foreground">{event.action}</td>
      <td className="px-4 py-2">
        <span className="text-ink">{event.object_type}</span>{" "}
        <span className="font-mono text-[11px] text-muted-2">{event.object_id}</span>
      </td>
    </tr>
  );
}
