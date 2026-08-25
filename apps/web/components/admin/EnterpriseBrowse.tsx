"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { OrgEntitlementsCard } from "@/components/admin/OrgEntitlementsCard";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/ui/LocalDateTime";
import {
  CAPABILITY_LABELS,
  type DeploymentEntitlement,
  type EnterpriseCapabilityKey
} from "@/lib/entitlements";

type OrgOption = { id: string; slug: string; name: string };

type EnterpriseBrowseProps = {
  grants: DeploymentEntitlement[];
  orgs: OrgOption[];
};

const INPUT_CLASS =
  "w-full min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 text-[13px] " +
  "text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";

/**
 * The Enterprise switchboard: pick any organization and flip its enterprise
 * features, plus a deployment-wide view of every grant currently held. The
 * per-org editor is the same card the org detail page mounts, so the two
 * surfaces can never drift.
 */
export function EnterpriseBrowse({ grants, orgs }: EnterpriseBrowseProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return [];
    }
    return orgs
      .filter(
        (org) =>
          org.name.toLowerCase().includes(needle) ||
          org.slug.toLowerCase().includes(needle) ||
          org.id === needle
      )
      .slice(0, 8);
  }, [orgs, query]);

  const selected = orgs.find((org) => org.id === selectedOrgId) ?? null;

  // Group the deployment-wide grants per org for the summary table.
  const byOrg = useMemo(() => {
    const groups = new Map<string, { label: string; rows: DeploymentEntitlement[] }>();
    for (const grant of grants) {
      const label = grant.org_name ?? grant.org_slug ?? grant.org_id;
      const group = groups.get(grant.org_id) ?? { label, rows: [] };
      group.rows.push(grant);
      groups.set(grant.org_id, group);
    }
    return [...groups.entries()];
  }, [grants]);

  return (
    <div className="flex flex-col gap-5">
      <Card className="p-[18px]">
        <h3 className="m-0 text-[13px] font-semibold text-ink">Manage an organization</h3>
        <p className="mb-3 mt-1 text-[12px] text-muted">
          Search by name, slug, or id, then grant or revoke each feature. Changes bind within
          about 30 seconds on warm pods.
        </p>
        <input
          aria-label="Search organizations"
          className={INPUT_CLASS}
          placeholder="acme, acme-inc, or an org id"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedOrgId(null);
          }}
        />
        {matches.length > 0 && selected === null && (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {matches.map((org) => (
              <li key={org.id}>
                <button
                  className="w-full rounded-[var(--radius-md)] border border-line px-3 py-2 text-left text-[13px] text-ink hover:bg-hover"
                  type="button"
                  onClick={() => setSelectedOrgId(org.id)}
                >
                  {org.name} <span className="font-mono text-[11px] text-muted-2">{org.slug}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {selected !== null && (
        <div>
          <p className="mb-2 mt-0 text-[13px] text-muted">
            Editing <span className="font-semibold text-ink">{selected.name}</span>{" "}
            <span className="font-mono text-[11px] text-muted-2">{selected.slug}</span>
          </p>
          {/* The grants summary below derives from the server-rendered prop, so a
              grant/revoke here must refresh the route or the two sections diverge. */}
          <OrgEntitlementsCard orgId={selected.id} onChanged={() => router.refresh()} />
        </div>
      )}
      <Card className="p-[18px]">
        <h3 className="m-0 text-[13px] font-semibold text-ink">Current grants</h3>
        <p className="mb-3 mt-1 text-[12px] text-muted">
          Every organization holding an enterprise grant right now. Expired rows stay listed so
          a lapsed pilot is visible rather than silently gone.
        </p>
        {byOrg.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">
            No organization holds an enterprise grant. The features are absent for everyone.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {byOrg.map(([orgId, group]) => (
              <li
                key={orgId}
                className="rounded-[var(--radius-md)] border border-line px-3 py-2"
              >
                <button
                  className="border-0 bg-transparent p-0 text-left text-[13px] font-semibold text-ink hover:underline"
                  type="button"
                  onClick={() => {
                    setSelectedOrgId(orgId);
                    setQuery(group.label);
                  }}
                >
                  {group.label}
                </button>
                <div className="mt-1 flex flex-wrap gap-2">
                  {group.rows.map((row) => {
                    const expired =
                      row.expires_at != null && new Date(row.expires_at).getTime() <= Date.now();
                    return (
                      <span
                        key={row.capability}
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${
                          expired ? "border-line text-muted-2 line-through" : "border-line-strong text-ink"
                        }`}
                      >
                        {CAPABILITY_LABELS[row.capability as EnterpriseCapabilityKey] ??
                          row.capability}
                        {row.expires_at != null && (
                          <>
                            {" "}
                            <LocalDateTime value={row.expires_at} />
                          </>
                        )}
                      </span>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
