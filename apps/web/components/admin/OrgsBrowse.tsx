"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Plus, Search } from "lucide-react";

import { foundingMemberEmail } from "@/lib/admin/founding-admin";
import { OrgLabelBadge } from "@/lib/admin/org-labels";
import type { AdministeredOrg } from "@/lib/admin/orgs-server";
import { useOrgUsage, type OrgCredit } from "@/lib/admin/use-org-usage";
import { platformUsageUrl, useUsageRows } from "@/components/overview/use-gateway-usage";
import { addDays, utcToday, type PlatformUsageRow } from "@/lib/gateway-usage";
import { formatCostUsd, formatSignedCostUsd } from "@/lib/money";
import { formatDateWithYear } from "@/lib/format";
import { useDisplayTimeZone } from "@/components/ui/LocalDateTime";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dropdown } from "@/components/ui/Dropdown";
import { readApiError } from "@/components/world-models/wm-client";
import { adminOrgPath } from "@/lib/routes";

const INPUT_CLASS =
  "w-full min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";
const ORGANIZATIONS_PER_PAGE = 10;
const PILL_BUTTON =
  "cursor-pointer rounded-full border border-line bg-transparent px-3 py-1 text-[12px] text-foreground/60 hover:border-line-strong hover:text-foreground disabled:cursor-not-allowed disabled:text-foreground/25 disabled:hover:border-line";

type SortKey = "spend" | "name" | "created" | "members" | "balance" | "usage";

// Selectable spend window for the default ordering; the product owner: last 7 days by
// default, ties broken by the most recently created org.
const SPEND_WINDOW_OPTIONS = [1, 7, 30] as const;
type SpendWindowDays = (typeof SPEND_WINDOW_OPTIONS)[number];
const MICRO_PER_USD = 1_000_000;
// The day rollup refreshes on a slower cadence than the 3s per-org credit
// poll: it is a platform-wide aggregate read, and minute-level freshness is
// enough for the "spend today" ordering to track a spending tenant.
const DAY_SPEND_POLL_INTERVAL_MS = 30_000;
type FilterKey = "all" | "caps-lifted" | "needs-review";

type OrgsBrowseProps = {
  orgs: AdministeredOrg[];
};

/** Metered spend across every attempt loaded so far, or null while loading. */
function usageOf(credit: OrgCredit | null | undefined): number | null {
  return credit ? credit.spend_usd : null;
}

function balanceOf(credit: OrgCredit | null | undefined): number | null {
  return credit ? credit.credit_balance_usd : null;
}

/**
 * The admin Organizations browse: every tenant as a card (name/slug, created,
 * members, credits granted/remaining, recent usage) that clicks through to the
 * org's admin detail page. Searchable by name/slug/founder email, sortable,
 * and filterable by status. Creating a tenant lives here too; per-org management (grants, caps,
 * members, deletion) lives on the detail page this links to. Platform-admin
 * gated by the admin layout above; customers never see it.
 */
export function OrgsBrowse({ orgs }: OrgsBrowseProps) {
  const timeZone = useDisplayTimeZone();
  const creditByOrg = useOrgUsage(useMemo(() => orgs.map((org) => org.id), [orgs]));

  const [addOpen, setAddOpen] = useState(false);

  // Special-attribute label keys per org, fetched once for the whole list (one
  // batch read, no N+1 per card). Empty until it lands; badges appear on refresh.
  const [labelsByOrg, setLabelsByOrg] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/orgs/labels", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { labels?: Record<string, string[]> } | null) => {
        if (!cancelled && payload?.labels) {
          setLabelsByOrg(payload.labels);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("spend");
  const [windowDays, setWindowDays] = useState<SpendWindowDays>(7);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [page, setPage] = useState(1);

  // Per-org gateway spend over the selected trailing window (micro-USD), from
  // the platform telemetry rollup the admin Telemetry panel reads, re-read on
  // a slow poll so a left-open page tracks a spending tenant instead of
  // freezing at its mount-time snapshot. The day is pinned per mount so a
  // page open across midnight UTC keeps one consistent window.
  const [today] = useState(() => utcToday());
  const spendUrl = platformUsageUrl({
    groupBy: "org",
    from: addDays(today, -(windowDays - 1)),
    to: today
  });
  const windowSpendSnap = useUsageRows<PlatformUsageRow>(spendUrl, DAY_SPEND_POLL_INTERVAL_MS);
  // The rollup rows count only once they belong to the CURRENTLY selected
  // window: on a window switch there is one render where the label already
  // changed but the effect has not yet flipped loading, and forUrl still
  // points at the previous window. Gating on it (not loading) closes that
  // one-frame stale leak.
  const spendReady = windowSpendSnap.forUrl === spendUrl;
  // org_id -> window spend. Orgs missing from the rollup (no traffic in the
  // window) count as $0. While the read is in flight the map is empty, so
  // every org sorts as $0 (falling through to the createdAt tiebreak) and the
  // list re-sorts once when the data lands: one reorder, no blocked render.
  // loading is true ONLY while a NEW window's read is in flight (the 30s poll
  // refreshes silently), so gate the map on it: a window switch must not sort
  // or label the new window with the previous window's figures.
  const windowSpendMicroByOrg = useMemo(() => {
    const map = new Map<string, number>();
    if (!spendReady) {
      return map;
    }
    for (const row of windowSpendSnap.rows ?? []) {
      if (row.org_id !== null) {
        map.set(row.org_id, row.spend_micro_usd);
      }
    }
    return map;
  }, [windowSpendSnap.rows, spendReady]);

  const visibleOrgs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = orgs.filter((org) => {
      if (needle !== "") {
        // The founder email is the most identifying string on the card, so it
        // must be findable through the same box.
        const haystack =
          `${org.name} ${org.slug} ${foundingMemberEmail(org.members) ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) {
          return false;
        }
      }
      const credit = creditByOrg[org.id];
      // A status filter matches only a CONFIRMED status. A status we do not know
      // yet (undefined = loading) or could not read (null = failed bulk load) is
      // not a match — otherwise a failed usage read would park every org under
      // both status filters even though its card shows unavailable usage. The
      // loading case is handled by the empty-state copy below, not by matching.
      switch (filter) {
        case "caps-lifted":
          return credit != null && credit.free_credit_caps_lifted_at != null;
        case "needs-review":
          return credit != null && credit.gateway_unknown_cost_attempts > 0;
        case "all":
          return true;
      }
    });
    const sorted = [...matched];
    sorted.sort((a, b) => {
      switch (sort) {
        case "spend": {
          // Highest spend over the selected window first; ties break on
          // createdAt, newest first (fresh signups surface over dormant orgs).
          const spendDiff =
            (windowSpendMicroByOrg.get(b.id) ?? 0) - (windowSpendMicroByOrg.get(a.id) ?? 0);
          return spendDiff !== 0 ? spendDiff : b.createdAt.localeCompare(a.createdAt);
        }
        case "name":
          return a.name.localeCompare(b.name);
        case "created":
          // Newest first.
          return b.createdAt.localeCompare(a.createdAt);
        case "members":
          return b.members.length - a.members.length;
        case "balance":
          // Lowest remaining first surfaces the orgs closest to running out;
          // orgs whose usage has not loaded yet sort last.
          return (balanceOf(creditByOrg[a.id]) ?? Infinity) - (balanceOf(creditByOrg[b.id]) ?? Infinity);
        case "usage":
          // Highest recent spend first.
          return (usageOf(creditByOrg[b.id]) ?? -1) - (usageOf(creditByOrg[a.id]) ?? -1);
      }
    });
    return sorted;
  }, [orgs, creditByOrg, windowSpendMicroByOrg, query, sort, filter]);

  const pageCount = Math.max(1, Math.ceil(visibleOrgs.length / ORGANIZATIONS_PER_PAGE));
  const currentPage = Math.min(page, pageCount);
  const pagedOrgs = visibleOrgs.slice(
    (currentPage - 1) * ORGANIZATIONS_PER_PAGE,
    currentPage * ORGANIZATIONS_PER_PAGE
  );

  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [page, pageCount]);

  // A status filter matches only confirmed statuses, so before usage lands it
  // matches nothing; distinguish that transient window from a genuine "no
  // matches" so the empty state does not read as a false negative during load.
  const usageStillLoading =
    filter !== "all" && orgs.some((org) => creditByOrg[org.id] === undefined);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search
            aria-hidden
            size={14}
            strokeWidth={1.8}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2"
          />
          <input
            aria-label="Search organizations"
            className={`${INPUT_CLASS} pl-8`}
            type="search"
            placeholder="Search by name, slug, or founder email"
            value={query}
            onChange={(event) => {
              setPage(1);
              setQuery(event.target.value);
            }}
          />
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          Sort
          <Dropdown
            aria-label="Sort organizations"
            value={sort}
            onChange={(event) => {
              setPage(1);
              setSort(event.target.value as SortKey);
            }}
          >
            <option value="spend">{`Spend (last ${windowDays}d)`}</option>
            <option value="name">Name (A-Z)</option>
            <option value="created">Newest</option>
            <option value="members">Members</option>
            <option value="balance">Credits remaining</option>
            <option value="usage">Recent usage</option>
          </Dropdown>
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          Window
          <Dropdown
            aria-label="Spend window"
            value={windowDays}
            onChange={(event) => {
              setPage(1);
              setWindowDays(Number(event.target.value) as SpendWindowDays);
            }}
          >
            {SPEND_WINDOW_OPTIONS.map((days) => (
              <option key={days} value={days}>
                {days === 1 ? "Today" : `Last ${days} days`}
              </option>
            ))}
          </Dropdown>
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-muted">
          Filter
          <Dropdown
            aria-label="Filter organizations"
            value={filter}
            onChange={(event) => {
              setPage(1);
              setFilter(event.target.value as FilterKey);
            }}
          >
            <option value="all">All organizations</option>
            <option value="caps-lifted">Free-credit caps lifted</option>
            <option value="needs-review">Needs pricing review</option>
          </Dropdown>
        </label>
        <Button
          className="ml-auto"
          onClick={() => setAddOpen(true)}
          type="button"
          variant="primary"
        >
          <Plus aria-hidden size={14} strokeWidth={2} />
          Add organization
        </Button>
      </div>

      {addOpen ? <AddOrganizationModal onClose={() => setAddOpen(false)} /> : null}

      {windowSpendSnap.error !== null && spendReady ? (
        // A failed rollup read silently degrades the default ordering to the
        // createdAt tiebreak, so say both facts out loud: the read failed and
        // the spend sort is not what the select claims.
        <p className="m-0 text-[13px] text-danger">
          {`Spend for the last ${windowDays}d is unavailable (${windowSpendSnap.error})`}
          {sort === "spend" ? "; ordering by newest instead" : ""}.
        </p>
      ) : null}

      {visibleOrgs.length === 0 ? (
        <Card>
          <p className="m-0 text-[13px] text-muted">
            {orgs.length === 0
              ? "No organizations yet. Create one above."
              : usageStillLoading
                ? "Loading organization usage…"
                : "No organizations match your search."}
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {pagedOrgs.map((org) => {
              const credit = creditByOrg[org.id];
              const founderEmail = foundingMemberEmail(org.members);
              // Null until the day rollup lands (or after a failed read, which
              // formatCostUsd renders as a dash rather than a false $0).
              const windowSpendUsd =
                !spendReady || windowSpendSnap.rows == null
                  ? null
                  : (windowSpendMicroByOrg.get(org.id) ?? 0) / MICRO_PER_USD;
              return (
                <Link
                  key={org.id}
                  href={adminOrgPath(org.id)}
                  className="group flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-surface p-4 no-underline transition-all duration-150 hover:border-line-strong hover:shadow-[0_4px_14px_rgba(20,20,18,0.06)]"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-[7px] bg-foreground text-[13px] font-bold text-white">
                      {org.name.charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[15px] font-semibold tracking-tight text-ink">
                        {org.name}
                      </span>
                      <span className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-muted-2">
                        {org.slug}
                      </span>
                      {founderEmail !== null ? (
                        <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-muted">
                          {founderEmail}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
                    <div className="flex flex-col">
                      <dt className="text-muted-2">Created</dt>
                      <dd className="m-0 text-ink">{formatDateWithYear(org.createdAt, timeZone)}</dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-muted-2">Members</dt>
                      <dd className="m-0 text-ink">{org.members.length}</dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-muted-2">Credits</dt>
                      <dd className="m-0 font-mono text-ink">
                        {credit === undefined
                          ? "…"
                          : credit === null
                            ? "unavailable"
                            : `${formatSignedCostUsd(credit.credit_balance_usd)} of ${formatCostUsd(credit.credit_granted_usd)}`}
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-muted-2">Recent usage</dt>
                      <dd className="m-0 font-mono text-ink">
                        {credit === undefined
                          ? "…"
                          : credit === null
                            ? "unavailable"
                            : formatCostUsd(credit.spend_usd)}
                        <span className="text-muted-2">
                          {" "}
                          {` · ${windowDays}d `}
                          {!spendReady && windowSpendSnap.error === null
                            ? "…"
                            : formatCostUsd(windowSpendUsd)}
                        </span>
                      </dd>
                    </div>
                  </dl>

                  {(labelsByOrg[org.id]?.length ?? 0) > 0 ||
                  org.ban !== null ||
                  (credit &&
                    (credit.free_credit_caps_lifted_at != null ||
                      credit.gateway_unknown_cost_attempts > 0)) ? (
                    <div className="flex flex-wrap gap-1.5">
                      {(labelsByOrg[org.id] ?? []).map((key) => (
                        <OrgLabelBadge key={key} labelKey={key} />
                      ))}
                      {org.ban !== null ? (
                        <span className="rounded border border-danger/40 px-1.5 py-0.5 text-[11px] font-medium text-danger">
                          Banned
                        </span>
                      ) : null}
                      {credit?.free_credit_caps_lifted_at != null ? (
                        <span className="rounded border border-line-strong px-1.5 py-0.5 text-[11px] text-muted">
                          Caps lifted
                        </span>
                      ) : null}
                      {credit != null && credit.gateway_unknown_cost_attempts > 0 ? (
                        <span className="rounded border border-danger/40 px-1.5 py-0.5 text-[11px] text-danger">
                          {credit.gateway_unknown_cost_attempts} unknown-cost
                        </span>
                      ) : null}
                    </div>
                  ) : null}

                  <span className="mt-auto inline-flex items-center gap-1 text-[12px] font-medium text-muted transition-colors group-hover:text-ink">
                    Manage organization
                    <ArrowRight
                      aria-hidden
                      size={13}
                      strokeWidth={1.8}
                      className="transition-transform group-hover:translate-x-0.5"
                    />
                  </span>
                </Link>
              );
            })}
          </div>
          {pageCount > 1 ? (
            <OrganizationsPager
              currentPage={currentPage}
              pageCount={pageCount}
              total={visibleOrgs.length}
              onPageChange={(nextPage) => setPage(nextPage)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

type OrganizationsPagerProps = {
  currentPage: number;
  pageCount: number;
  total: number;
  onPageChange: (page: number) => void;
};

function OrganizationsPager({ currentPage, pageCount, total, onPageChange }: OrganizationsPagerProps) {
  const firstItem = (currentPage - 1) * ORGANIZATIONS_PER_PAGE + 1;
  const lastItem = Math.min(currentPage * ORGANIZATIONS_PER_PAGE, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-[12px]">
      <span className="text-muted">
        Showing {firstItem}–{lastItem} of {total}
      </span>
      <div className="flex items-center gap-2">
        <span aria-live="polite" className="text-muted">
          Page {currentPage} of {pageCount}
        </span>
        <button
          className={PILL_BUTTON}
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
          type="button"
        >
          Previous
        </button>
        <button
          className={PILL_BUTTON}
          disabled={currentPage >= pageCount}
          onClick={() => onPageChange(currentPage + 1)}
          type="button"
        >
          Next
        </button>
      </div>
    </div>
  );
}

type CreatedOrganization = {
  id: string;
  name: string;
  slug: string;
  founderEmail: string;
  /** "created" = fresh account provisioned; "existing" = known address added as founder. */
  founderStatus: "created" | "existing";
  /** Whether the verification link (created) or sign-in code (existing) email went out. */
  emailSent: boolean;
};

/**
 * The "Add organization" dialog: name plus the REQUIRED founder email. The
 * route binds that email as the org's founding admin and leaves the org behind
 * the same spend gate as self-serve signups, so the copy here says exactly
 * that: credits stay locked until the founder verifies their inbox. Rides the
 * shared ConfirmDialog shell (form-in-dialog precedent: the admin ban dialog);
 * the parent mounts it only while open, so every dismissal path unmounts and
 * resets the form and the success state.
 */
function AddOrganizationModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [founderEmail, setFounderEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedOrganization | null>(null);

  async function createOrganization() {
    if (busy) {
      return;
    }
    if (name.trim() === "" || founderEmail.trim() === "") {
      setError("Enter both an organization name and the founder's email.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/admin/orgs", {
        body: JSON.stringify({ name: name.trim(), founder_email: founderEmail.trim() }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to create the organization."));
        return;
      }
      const payload = (await response.json()) as {
        organization: { id: string; name: string; slug: string };
        founder: { email: string; status: "created" | "existing" };
        verification_email_sent?: boolean;
      };
      setCreated({
        ...payload.organization,
        founderEmail: payload.founder.email,
        founderStatus: payload.founder.status,
        emailSent: payload.verification_email_sent === true
      });
      router.refresh();
    } catch {
      // A network failure must surface like an API refusal, not vanish.
      setError("Unable to create the organization. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (created !== null) {
    return (
      <ConfirmDialog
        open
        title="Organization created"
        tone="neutral"
        body={
          <>
            <span className="font-semibold text-ink">{created.name}</span>{" "}
            <span className="font-mono text-[11px] text-muted-2">({created.slug})</span> now
            belongs to <span className="text-ink">{created.founderEmail}</span>.{" "}
            {created.founderStatus === "created"
              ? created.emailSent
                ? "Their account was just created and a verification link was emailed to them."
                : "Their account was just created, but the verification email could not be sent; ask them to sign in with an emailed code instead."
              : created.emailSent
                ? "The organization was added to their existing account and a sign-in code was emailed to them."
                : "The organization was added to their existing account, but the sign-in email could not be sent; ask them to sign in with an emailed link or code."}{" "}
            Credits stay locked until they verify their inbox.
          </>
        }
        confirmLabel="Manage organization"
        busyLabel="Opening…"
        busy={false}
        cancelLabel="Done"
        onCancel={onClose}
        onConfirm={() => {
          onClose();
          router.push(adminOrgPath(created.id));
        }}
      />
    );
  }

  return (
    <ConfirmDialog
      open
      title="Add organization"
      tone="neutral"
      body="The founder becomes the organization's admin. Its welcome credit stays locked until they verify their inbox by signing in with an emailed link or code."
      confirmLabel="Create organization"
      busyLabel="Creating…"
      busy={busy}
      error={error}
      onCancel={onClose}
      onConfirm={() => void createOrganization()}
    >
      <div className="mt-4 flex flex-col gap-3">
        <div>
          <label
            className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/25"
            htmlFor="add-org-name"
          >
            Organization name
          </label>
          <input
            id="add-org-name"
            className={INPUT_CLASS}
            type="text"
            required
            placeholder="Acme Robotics"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div>
          <label
            className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/25"
            htmlFor="add-org-founder-email"
          >
            Founder email
          </label>
          <input
            id="add-org-founder-email"
            className={INPUT_CLASS}
            type="email"
            required
            placeholder="founder@acme.com"
            value={founderEmail}
            onChange={(event) => setFounderEmail(event.target.value)}
          />
        </div>
      </div>
    </ConfirmDialog>
  );
}
