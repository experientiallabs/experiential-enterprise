"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/ui/LocalDateTime";
import { Shimmer } from "@/components/ui/Shimmer";
import {
  CAPABILITY_LABELS,
  ENTERPRISE_CAPABILITIES,
  type EnterpriseCapabilityKey,
  type OrgEntitlement
} from "@/lib/entitlements";

type OrgEntitlementsCardProps = {
  orgId: string;
  /** Fires after a grant or revoke lands, so a host view can refetch its own state. */
  onChanged?: () => void;
};

/**
 * The operator's enterprise switchboard for one org: grant or revoke each /ee
 * capability. A grant licenses exactly this org (the hosted entitlement tier);
 * without one the feature is absent from the org's product entirely. Grants
 * and revokes are audit-logged by the backend.
 */
export function OrgEntitlementsCard({ orgId, onChanged }: OrgEntitlementsCardProps) {
  const [rows, setRows] = useState<OrgEntitlement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const response = await fetch(`/api/admin/orgs/${encodeURIComponent(orgId)}/entitlements`);
      if (!response.ok) {
        throw new Error(`Entitlements failed to load (${response.status}).`);
      }
      const payload = (await response.json()) as { entitlements: OrgEntitlement[] };
      setRows(payload.entitlements);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Entitlements failed to load.");
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one load per org
  }, [orgId]);

  async function setGrant(capability: EnterpriseCapabilityKey, granted: boolean): Promise<void> {
    setBusyKey(capability);
    setError(null);
    try {
      const response = await fetch(
        `/api/admin/orgs/${encodeURIComponent(orgId)}/entitlements/${capability}`,
        granted
          ? { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }
          : { method: "DELETE" }
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `The change failed (${response.status}).`);
      }
      await refresh();
      onChanged?.();
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : "The change failed.");
    } finally {
      setBusyKey(null);
    }
  }

  const byCapability = new Map((rows ?? []).map((row) => [row.capability, row]));

  return (
    <Card className="p-[18px]">
      <h3 className="m-0 text-[13px] font-semibold text-ink">Enterprise entitlements</h3>
      <p className="mb-3 mt-1 text-[12px] text-muted">
        A grant licenses this organization for one enterprise feature. Without a grant the
        feature is absent from their product, no locked pages, no upsell. Every change is
        audit-logged.
      </p>
      {rows === null && !error ? (
        <Shimmer className="h-24 w-full" />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {ENTERPRISE_CAPABILITIES.map((capability) => {
            const grant = byCapability.get(capability);
            const expired =
              grant?.expires_at != null && new Date(grant.expires_at).getTime() <= Date.now();
            const active = grant !== undefined && !expired;
            return (
              <li
                key={capability}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-line px-3 py-2"
              >
                <div className="min-w-0">
                  <span className="text-[13px] text-ink">{CAPABILITY_LABELS[capability]}</span>
                  <span className="ml-2 font-mono text-[11px] text-muted-2">{capability}</span>
                  {grant?.expires_at != null && (
                    <span className="ml-2 text-[11px] text-muted">
                      {expired ? "expired " : "until "}
                      <LocalDateTime value={grant.expires_at} />
                    </span>
                  )}
                </div>
                <Button
                  disabled={busyKey !== null}
                  size="sm"
                  variant={active ? "default" : "primary"}
                  onClick={() => void setGrant(capability, !active)}
                >
                  {busyKey === capability ? "Saving..." : active ? "Revoke" : "Grant"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="mb-0 mt-2 text-[13px] text-danger">{error}</p>}
    </Card>
  );
}
