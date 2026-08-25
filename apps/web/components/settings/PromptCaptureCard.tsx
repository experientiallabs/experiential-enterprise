"use client";

import { useEffect, useState } from "react";

import { Card } from "@/components/ui/Card";
import type { TelemetrySettings } from "@/lib/types";

/**
 * The org-wide opt-in to capture request/response CONTENT in telemetry (the product owner:
 * "track as much as we possibly can about the API call without tracking the
 * data. but there should be an opt in to actually capture the prompt data as
 * well"). Default OFF and privacy-preserving: the content-free metadata stream
 * — tokens, cost, latency, provider, outcome reason — is always captured, and
 * only this switch authorizes also storing the message content. Admin-gated,
 * because it is a privacy decision for the whole organization.
 */
export function PromptCaptureCard({
  orgId,
  canManage
}: {
  orgId: string;
  canManage: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/api/orgs/${encodeURIComponent(orgId)}/telemetry-settings`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok || !live) {
          return;
        }
        const body = (await response.json()) as TelemetrySettings;
        if (live) {
          setEnabled(Boolean(body.capture_prompt_content));
          setLoaded(true);
        }
      })
      // The card degrades to its explanation; the next visit retries.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [orgId]);

  async function save(next: boolean): Promise<void> {
    setSaving(true);
    setError(null);
    const previous = enabled;
    setEnabled(next);
    try {
      const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/telemetry-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capture_prompt_content: next })
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "The setting could not be saved.");
      }
    } catch (saveError) {
      setEnabled(previous);
      setError(saveError instanceof Error ? saveError.message : "The setting could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-col gap-2">
        <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-2">
          Prompt content capture
        </p>
        <p className="m-0 max-w-[640px] text-[12.5px] leading-relaxed text-muted">
          Telemetry always records everything about a call except the data itself, model,
          identity, lane, token counts, cost, latency, and the reason each request ended. The
          prompt groups on Insights are content-free fingerprints and work without this. Turn
          this on to also capture the prompt and response content for this organization&apos;s
          requests. Off by default; while it is off, message content is never stored.
        </p>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-[13px] text-ink">
          <input
            aria-label="Capture prompt and response content"
            checked={enabled}
            disabled={!canManage || !loaded || saving}
            onChange={(event) => void save(event.target.checked)}
            type="checkbox"
          />
          {enabled ? "Capturing prompt content" : "Content capture off (metadata only)"}
        </label>
        {!canManage && loaded ? (
          <p className="m-0 text-[12px] text-muted-2">Only an organization admin can change this.</p>
        ) : null}
        {error !== null ? <p className="m-0 text-[12px] text-danger">{error}</p> : null}
      </div>
    </Card>
  );
}
