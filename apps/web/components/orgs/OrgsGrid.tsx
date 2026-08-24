"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { BrandMark } from "@/components/brand/BrandMark";
import { ContributionGrid } from "@/components/onboarding/ContributionGrid";
import { readApiError } from "@/components/world-models/wm-client";
import type { Org } from "@/lib/types";
import { overviewPath } from "@/lib/routes";

type OrgsGridProps = {
  orgs: Org[];
  /**
   * Platform operators only (the product owner, 2026-08-01): creation goes through the
   * admin-gated /api/admin/orgs, so this renders nothing for anyone the
   * backend would refuse anyway.
   */
  canCreate?: boolean;
};

export function OrgsGrid({ orgs, canCreate = false }: OrgsGridProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The cookie write must land before navigation, so the click has a real
  // wait; without visible feedback it read as ignored on a slow connection
  // (the product owner, 2026-07-30).
  const [openingOrgId, setOpeningOrgId] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");
  // Every org-create surface requires the founder's email (the product owner's rule): the
  // route binds it as the founding admin and the org stays spend-locked until
  // that inbox is verified.
  const [createFounderEmail, setCreateFounderEmail] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // The switcher's "New organization" item lands here with ?create=1, so the
  // form is ready to type into on arrival.
  const focusCreate = searchParams.get("create") === "1";

  async function createOrg(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (createName.trim().length === 0 || createFounderEmail.trim().length === 0 || isCreating) {
      return;
    }
    setCreateError(null);
    setIsCreating(true);
    try {
      const response = await fetch("/api/admin/orgs", {
        body: JSON.stringify({ name: createName, founder_email: createFounderEmail.trim() }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        setCreateError(await readApiError(response, "Unable to create the organization."));
        return;
      }
      setCreateName("");
      setCreateFounderEmail("");
      // The new org appears in the grid via the refreshed server payload.
      router.refresh();
    } catch {
      // A network failure must surface like an API refusal, not vanish.
      setCreateError("Unable to create the organization.");
    } finally {
      setIsCreating(false);
    }
  }

  // Opening an org = writing the active-org cookie, then landing on the
  // workspace root; URLs do not carry the org (mirrors the org switcher).
  async function openOrg(org: Org): Promise<void> {
    if (openingOrgId !== null) {
      return;
    }
    setOpeningOrgId(org.id);
    const response = await fetch("/api/active-org", {
      body: JSON.stringify({ org: org.slug }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    // Navigating without the cookie write would silently land in the OLD org;
    // staying put is the lesser surprise.
    if (!response.ok) {
      setOpeningOrgId(null);
      return;
    }
    router.push(overviewPath());
    router.refresh();
  }

  return (
    <div className="relative min-h-screen bg-background overflow-hidden">
      <div className="absolute inset-0 opacity-35">
        <ContributionGrid className="w-full h-full" dark />
      </div>
      {/* Fade the tiling toward the content area so tiles stay readable. */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/70 to-background" />

      <div className="relative z-10 mx-auto w-full max-w-[1040px] px-6 py-16">
        <div className="mb-10">
          <div className="inline-flex items-center gap-2.5 mb-5">
            <div className="w-7 h-7 bg-foreground rounded-lg flex items-center justify-center">
              <BrandMark className="w-4 h-4 text-white" />
            </div>
            <span className="text-[11px] font-semibold text-muted tracking-[0.15em] uppercase font-mono">
              Experiential
            </span>
          </div>
          <div className="flex items-end justify-between gap-4">
            <div>
              <h1 className="m-0 text-ink text-2xl font-semibold tracking-tight">
                Organizations
              </h1>
              <p className="mt-1.5 text-sm text-muted">
                Each organization builds simulations from its own traces.
              </p>
            </div>
            <span className="text-muted text-[13px]">{orgs.length} total</span>
          </div>
        </div>

        {orgs.length === 0 && !canCreate ? (
          <section className="grid min-h-[220px] place-items-center border border-dashed border-line-strong rounded-[var(--radius-lg)] text-center">
            <div className="max-w-[520px] px-6">
              <h2 className="m-0 text-[#474747] text-sm font-medium">No organizations yet</h2>
              <p className="mt-2 text-muted text-[13px] leading-relaxed">
                Organizations are provisioned with your account or by an organization invitation.
                If you expected one here, ask your organization&apos;s admin for an invite.
              </p>
            </div>
          </section>
        ) : null}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {orgs.map((org) => (
            <button
              key={org.id}
              aria-busy={openingOrgId === org.id}
              disabled={openingOrgId !== null}
              onClick={() => void openOrg(org)}
              type="button"
              className="group flex flex-col gap-3 border border-line rounded-[var(--radius-lg)] bg-surface p-5 text-left no-underline transition-all duration-150 hover:border-line-strong hover:shadow-[0_4px_14px_rgba(20,20,18,0.06)] disabled:cursor-default"
            >
              <div className="flex items-center gap-2.5">
                <div className="grid w-8 h-8 place-items-center rounded-[7px] bg-foreground text-white text-[13px] font-bold">
                  {org.name.charAt(0)}
                </div>
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-ink text-[15px] font-semibold tracking-tight">
                  {org.name}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-mono text-xs text-muted overflow-hidden text-ellipsis whitespace-nowrap">
                  {org.slug}
                </span>
                <span className="text-xs text-muted-2 overflow-hidden text-ellipsis whitespace-nowrap">
                  World-model workspace
                </span>
              </div>
              <span className="mt-auto inline-flex items-center gap-1 text-[12px] font-medium text-muted transition-colors group-hover:text-ink">
                {openingOrgId === org.id ? "Opening…" : "Open organization"}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="transition-transform group-hover:translate-x-0.5"
                >
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </span>
            </button>
          ))}
          {canCreate ? (
            <form
              className="flex flex-col gap-3 border border-dashed border-line-strong rounded-[var(--radius-lg)] bg-surface/60 p-5"
              onSubmit={(event) => void createOrg(event)}
            >
              <span className="text-ink text-[15px] font-semibold tracking-tight">
                New organization
              </span>
              <input
                aria-label="Organization name"
                autoFocus={focusCreate}
                className="w-full min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]"
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="acme-support"
                value={createName}
              />
              <input
                aria-label="Founder email"
                className="w-full min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]"
                onChange={(event) => setCreateFounderEmail(event.target.value)}
                placeholder="founder@acme.com"
                type="email"
                value={createFounderEmail}
              />
              <p className="m-0 text-[11px] leading-relaxed text-muted">
                The founder becomes the admin; credits stay locked until they verify their inbox.
              </p>
              {createError ? (
                <p className="m-0 text-[12px] text-danger" role="alert">
                  {createError}
                </p>
              ) : null}
              <button
                className="mt-auto w-fit cursor-pointer rounded-md border-0 bg-foreground px-3 py-1.5 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-55"
                disabled={
                  createName.trim().length === 0 ||
                  createFounderEmail.trim().length === 0 ||
                  isCreating
                }
                type="submit"
              >
                {isCreating ? "Creating…" : "Create organization"}
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}
