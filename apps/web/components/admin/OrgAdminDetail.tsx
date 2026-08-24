"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, X } from "lucide-react";

import { foundingMemberEmail } from "@/lib/admin/founding-admin";
import {
  KNOWN_ORG_LABEL_KEYS,
  OrgLabelBadge,
  orgLabelDisplay
} from "@/lib/admin/org-labels";
import type { OrgAdminNote, OrgLabel } from "@/lib/admin/org-labels-types";
import type { AdministeredOrgDetail } from "@/lib/admin/orgs-server";
import type { WelcomeTriggerView } from "@/lib/backend-source";
import { UserAccountActions } from "@/components/admin/UserAccountActions";
import { creditCell, useOrgUsage } from "@/lib/admin/use-org-usage";
import { formatDateTimeWithYear, formatDateWithYear } from "@/lib/format";
import { formatSignedCostUsd } from "@/lib/money";
import { OrgEntitlementsCard } from "@/components/admin/OrgEntitlementsCard";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dropdown } from "@/components/ui/Dropdown";
import { useDisplayTimeZone } from "@/components/ui/LocalDateTime";
import { MembersPanel } from "@/components/settings/MembersPanel";
import { readApiError } from "@/components/world-models/wm-client";
import { adminPath, overviewPath } from "@/lib/routes";

const INPUT_CLASS =
  "w-full min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";
const ACTION_CLASS =
  "inline-flex items-center rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[12px] cursor-pointer hover:border-[#bdbdbd] disabled:cursor-not-allowed disabled:opacity-55";

type OrgAdminDetailProps = {
  org: AdministeredOrgDetail;
  currentUserId: string;
};

/**
 * A single tenant's admin detail: open its workspace, grant or adjust credit,
 * lift/restore the free-credit daily caps, manage members through the shared
 * MembersPanel (with the shared per-user account actions), and delete the
 * account.
 * This is the click-through target from the admin Organizations cards; the
 * browse page holds the roster and creation, this page holds one org's tasks.
 */
export function OrgAdminDetail({ org, currentUserId }: OrgAdminDetailProps) {
  const router = useRouter();
  const timeZone = useDisplayTimeZone();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [banDialogOpen, setBanDialogOpen] = useState(false);
  const [banReason, setBanReason] = useState("");
  const [banDialogError, setBanDialogError] = useState<string | null>(null);
  const [unbanDialogOpen, setUnbanDialogOpen] = useState(false);
  const [unbanDialogError, setUnbanDialogError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  // The active-org cookie write must land before navigation, so opening has a
  // real wait; mirrors OrgsGrid.openOrg's visible "Opening…" feedback.
  const [opening, setOpening] = useState(false);
  const [grantDraft, setGrantDraft] = useState("");
  const creditByOrg = useOrgUsage([org.id]);
  const credit = creditByOrg[org.id];
  // The founding admin's email labels the header — org names alone are often
  // meaningless (auto-generated), the founder identifies the tenant.
  const founderEmail = foundingMemberEmail(org.members);

  async function run(key: string, action: () => Promise<Response>, successNotice: string) {
    setError(null);
    setNotice(null);
    setBusyKey(key);
    try {
      const response = await action();
      if (!response.ok) {
        setError(await readApiError(response, "The operation failed."));
        return;
      }
      setNotice(successNotice);
      router.refresh();
    } finally {
      setBusyKey(null);
    }
  }

  // Open the org's workspace = write the active-org cookie, then land on the
  // workspace root. A platform admin has no membership in most tenants, but
  // /api/active-org resolves through the admin all-orgs bypass, so setting any
  // org active is how /orgs "All organizations" already opens memberless orgs.
  async function openOrg() {
    if (opening) {
      return;
    }
    setError(null);
    setNotice(null);
    setOpening(true);
    try {
      const response = await fetch("/api/active-org", {
        body: JSON.stringify({ org: org.slug }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        setError(await readApiError(response, `Unable to open "${org.name}".`));
        setOpening(false);
        return;
      }
      router.push(overviewPath());
      router.refresh();
    } catch {
      setError(`Unable to open "${org.name}".`);
      setOpening(false);
    }
  }

  async function toggleFreeCreditCaps(lifted: boolean) {
    await run(
      "free-credit-caps",
      () =>
        fetch(`/api/admin/orgs/${org.id}/free-credit-caps`, {
          body: JSON.stringify({ lifted }),
          headers: { "content-type": "application/json" },
          method: "PUT"
        }),
      lifted
        ? `Free-credit daily caps lifted for "${org.name}".`
        : `Free-credit daily caps restored for "${org.name}".`
    );
  }

  async function applyGrant() {
    const raw = grantDraft.trim();
    const amountUsd = Number(raw);
    if (raw === "" || !Number.isFinite(amountUsd) || amountUsd === 0) {
      setError("The grant must be a non-zero dollar amount (negative adjusts credit down).");
      return;
    }
    await run(
      "grant",
      () =>
        fetch(`/api/admin/orgs/${org.id}/credit-grants`, {
          body: JSON.stringify({ amount_usd: amountUsd, reason: "Admin grant" }),
          headers: { "content-type": "application/json" },
          method: "POST"
        }),
      amountUsd > 0
        ? `Granted ${formatSignedCostUsd(amountUsd)} to "${org.name}".`
        : `Adjusted "${org.name}" by ${formatSignedCostUsd(amountUsd)}.`
    );
    setGrantDraft("");
  }

  async function confirmBanOrg() {
    const reason = banReason.trim();
    if (reason.length === 0) {
      setBanDialogError("A reason is required to ban an organization.");
      return;
    }
    setBanDialogError(null);
    setBusyKey(`ban-org:${org.id}`);
    try {
      const response = await fetch(`/api/admin/orgs/${org.id}/ban`, {
        body: JSON.stringify({ reason }),
        headers: { "content-type": "application/json" },
        method: "PUT"
      });
      if (!response.ok) {
        setBanDialogError(await readApiError(response, "Unable to ban the organization."));
        return;
      }
      setNotice(`"${org.name}" is banned.`);
      setError(null);
      setBanDialogOpen(false);
      router.refresh();
    } finally {
      setBusyKey(null);
    }
  }

  async function confirmUnbanOrg() {
    setUnbanDialogError(null);
    setBusyKey(`unban-org:${org.id}`);
    try {
      const response = await fetch(`/api/admin/orgs/${org.id}/ban`, { method: "DELETE" });
      if (!response.ok) {
        setUnbanDialogError(await readApiError(response, "Unable to unban the organization."));
        return;
      }
      setNotice(`"${org.name}" is unbanned. Revoked API keys and invites stay revoked.`);
      setError(null);
      setUnbanDialogOpen(false);
      router.refresh();
    } finally {
      setBusyKey(null);
    }
  }

  async function deleteOrg() {
    setError(null);
    setNotice(null);
    setBusyKey(`delete-org:${org.id}`);
    try {
      const response = await fetch(`/api/admin/orgs/${org.id}`, { method: "DELETE" });
      if (!response.ok) {
        setError(await readApiError(response, "The operation failed."));
        return;
      }
      // The org is gone; the browse roster reflects it after the refresh.
      router.push(adminPath());
      router.refresh();
    } finally {
      setBusyKey(null);
      setDeleteDialogOpen(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <button
        className="inline-flex w-fit items-center gap-1.5 border-0 bg-transparent p-0 text-[13px] text-muted transition-colors hover:text-ink"
        onClick={() => router.push(adminPath())}
        type="button"
      >
        <ArrowLeft aria-hidden size={14} strokeWidth={1.8} />
        All organizations
      </button>

      <Card className="p-0 overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-line px-[18px] py-3">
          <div className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <h1 className="m-0 truncate text-sm font-semibold text-ink">{org.name}</h1>
              {org.ban ? (
                <span className="shrink-0 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold uppercase text-danger">
                  Banned
                </span>
              ) : null}
            </span>
            <p className="m-0 truncate font-mono text-[11px] text-muted-2">
              {org.slug} · {org.members.length} member{org.members.length === 1 ? "" : "s"}
              {founderEmail !== null ? ` · ${founderEmail}` : null}
            </p>
            {org.ban ? (
              <p className="m-0 truncate text-[11px] text-danger">
                {org.ban.reason} · banned by {org.ban.bannedByEmail ?? "unknown"} on{" "}
                {formatDateWithYear(org.ban.bannedAt, timeZone)}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              className={`${ACTION_CLASS} gap-1`}
              disabled={busyKey !== null || opening}
              onClick={() => void openOrg()}
              type="button"
            >
              {opening ? "Opening…" : "Open"}
              <ArrowRight aria-hidden size={13} strokeWidth={1.8} />
            </button>
            {org.ban ? (
              <button
                className={ACTION_CLASS}
                disabled={busyKey !== null || opening}
                onClick={() => {
                  setUnbanDialogError(null);
                  setUnbanDialogOpen(true);
                }}
                type="button"
              >
                Unban organization
              </button>
            ) : (
              <button
                className={`${ACTION_CLASS} text-danger hover:border-danger/40`}
                disabled={busyKey !== null || opening}
                onClick={() => {
                  setBanReason("");
                  setBanDialogError(null);
                  setBanDialogOpen(true);
                }}
                type="button"
              >
                Ban organization
              </button>
            )}
            <button
              className={`${ACTION_CLASS} text-danger hover:border-danger/40`}
              disabled={busyKey !== null || opening}
              onClick={() => setDeleteDialogOpen(true)}
              type="button"
            >
              Delete organization
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-[18px] py-2.5">
          <span className="text-[12px] text-muted">
            Credits: <span className="font-mono text-ink">{creditCell(credit)}</span>
          </span>
          <input
            aria-label={`Credit grant for ${org.name} in USD`}
            className={`${INPUT_CLASS} max-w-[120px]`}
            type="number"
            step="0.01"
            placeholder="Amount"
            value={grantDraft}
            onChange={(event) => setGrantDraft(event.target.value)}
          />
          <button
            className={ACTION_CLASS}
            disabled={busyKey !== null}
            onClick={() => void applyGrant()}
            type="button"
          >
            Grant credit
          </button>
          {/* Ops lore: revoking a YC launch grant is a -506 adjustment here
              (restores the standard $20 promo the claim folded into the $526),
              plus setting the claim's revoked_at in SQL so expiry skips it. */}
          <span className="text-[11px] text-muted-2">
            Adds a credit ledger entry. Negative amounts reduce the balance.
          </span>
          {credit && (
            <>
              <button
                className={ACTION_CLASS}
                disabled={busyKey !== null}
                onClick={() =>
                  void toggleFreeCreditCaps(credit.free_credit_caps_lifted_at == null)
                }
                type="button"
              >
                {credit.free_credit_caps_lifted_at == null
                  ? "Lift free-credit caps"
                  : "Restore free-credit caps"}
              </button>
              {credit.gateway_unknown_cost_attempts > 0 && (
                <span className="text-[11px] text-danger">
                  {credit.gateway_unknown_cost_attempts} gateway attempt
                  {credit.gateway_unknown_cost_attempts === 1 ? "" : "s"} billed $0 for an
                  unknown cost. Review pricing.
                </span>
              )}
            </>
          )}
        </div>
        <div className="p-[18px]">
          <MembersPanel
            canManage
            currentUserId={currentUserId}
            // The same user-scoped account controls the admin Users page
            // offers; the ban flag rides on the detail loader's member type,
            // and the busy controls stop a panel action racing an account one.
            renderAccountActions={(member, controls) => (
              <UserAccountActions
                currentUserId={currentUserId}
                disabled={controls.disabled}
                onBusyChange={controls.onBusyChange}
                user={{
                  id: member.userId,
                  email: member.email,
                  banned: member.banned,
                  isExperientialAdmin: member.isExperientialAdmin
                }}
              />
            )}
            invites={org.invites}
            // Domain-based access-request approvals live on the org's own
            // Settings > Members surface, not this cross-tenant editor.
            joinRequests={[]}
            members={org.members}
            orgId={org.id}
          />
        </div>
      </Card>
      {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
      {notice && <p className="m-0 text-[13px] text-muted">{notice}</p>}

      <OrgEntitlementsCard orgId={org.id} />
      <OrgLabelsSection orgId={org.id} />
      <WelcomeTriggerSection orgId={org.id} trigger={org.welcomeTrigger} />
      <OrgNotesSection orgId={org.id} timeZone={timeZone} />

      <ConfirmDialog
        open={banDialogOpen}
        title={`Ban "${org.name}"?`}
        body="Banning locks this organization out of the platform. Every current member is banned from signing in (platform operators excepted), every API key of the organization is revoked, pending invites are revoked, and new keys, invites, and join approvals are blocked. Unbanning restores member sign-ins but never un-revokes keys or invites."
        confirmLabel="Confirm ban"
        busyLabel="Banning..."
        busy={busyKey === `ban-org:${org.id}`}
        tone="danger"
        confirmVariant="destructive"
        error={banDialogError}
        onCancel={() => setBanDialogOpen(false)}
        onConfirm={() => void confirmBanOrg()}
      >
        <label className="mt-4 block">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/25">
            Reason (required)
          </span>
          <textarea
            aria-label="Organization ban reason"
            className={`${INPUT_CLASS} min-h-[64px] py-2`}
            maxLength={500}
            placeholder="Why this organization is being banned"
            value={banReason}
            onChange={(event) => setBanReason(event.target.value)}
          />
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={unbanDialogOpen}
        title={`Unban "${org.name}"?`}
        body="Members banned by this organization ban can sign in again, except any member who still belongs to another banned organization. API keys and invites revoked at ban time stay revoked; members mint fresh keys and admins send fresh invites."
        confirmLabel="Confirm unban"
        busyLabel="Unbanning..."
        busy={busyKey === `unban-org:${org.id}`}
        tone="danger"
        error={unbanDialogError}
        onCancel={() => setUnbanDialogOpen(false)}
        onConfirm={() => void confirmUnbanOrg()}
      />

      <ConfirmDialog
        open={deleteDialogOpen}
        title={`Delete "${org.name}" and all tenant data?`}
        body="Members with no other organization will also be deleted from authentication. This cannot be undone."
        confirmLabel="Delete organization"
        busyLabel="Deleting..."
        busy={busyKey === `delete-org:${org.id}`}
        tone="danger"
        confirmVariant="destructive"
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={() => void deleteOrg()}
      />
    </div>
  );
}

const SECTION_LABEL_CLASS =
  "mb-1.5 block text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/25";

/**
 * The org's special-attribute labels: current badges (each removable) plus an
 * add control driven by the known-label display map. Self-contained state:
 * reads through the session BFF, which proxies the platform-admin FastAPI
 * routes, and refetches after every mutation.
 */
const ADMIN_INPUT_CLASS =
  "w-full min-h-[34px] rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 text-[13px] text-ink focus:outline-none focus:border-[#bdbdbd]";

/** Default YC grant expiry: three months out, as a date-input yyyy-mm-dd. */
function defaultYcExpiry(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 3);
  return d.toISOString().slice(0, 10);
}

function OrgLabelsSection({ orgId }: { orgId: string }) {
  const [labels, setLabels] = useState<OrgLabel[] | null>(null);
  const [selectedKey, setSelectedKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ycAmount, setYcAmount] = useState("526");
  const [ycExpiry, setYcExpiry] = useState(defaultYcExpiry());

  const refetch = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/orgs/${orgId}/labels`, { cache: "no-store" });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to load labels."));
        return;
      }
      const payload = (await response.json()) as { labels: OrgLabel[] };
      setLabels(payload.labels ?? []);
    } catch {
      setError("Unable to load labels.");
    }
  }, [orgId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const appliedKeys = new Set((labels ?? []).map((label) => label.key));
  const addableKeys = KNOWN_ORG_LABEL_KEYS.filter((key) => !appliedKeys.has(key));

  async function addLabel() {
    if (selectedKey === "" || busy) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/orgs/${orgId}/labels`, {
        body: JSON.stringify({ key: selectedKey }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to add the label."));
        return;
      }
      setSelectedKey("");
      await refetch();
    } finally {
      setBusy(false);
    }
  }

  async function removeLabel(key: string) {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/orgs/${orgId}/labels/${encodeURIComponent(key)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to remove the label."));
        return;
      }
      await refetch();
    } finally {
      setBusy(false);
    }
  }

  async function applyYcGrant() {
    if (busy) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const amount = Number(ycAmount);
      const body: { amount_usd?: number; expires_at?: string } = {};
      if (Number.isFinite(amount) && amount > 0) {
        body.amount_usd = amount;
      }
      if (ycExpiry) {
        body.expires_at = new Date(`${ycExpiry}T00:00:00Z`).toISOString();
      }
      const response = await fetch(`/api/admin/orgs/${orgId}/yc-grant`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to apply the YC grant."));
        return;
      }
      await refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="m-0 mb-3 text-sm font-semibold text-ink">Labels</h2>
      <div className="flex flex-wrap items-center gap-1.5">
        {labels === null ? (
          <span className="text-[12.5px] text-muted-2">Loading...</span>
        ) : labels.length === 0 ? (
          <span className="text-[12.5px] text-muted">No labels on this organization.</span>
        ) : (
          labels.map((label) => (
            <span className="inline-flex items-center gap-1" key={label.id}>
              <OrgLabelBadge labelKey={label.key} />
              <button
                aria-label={`Remove ${orgLabelDisplay(label.key).label} label`}
                className="cursor-pointer text-muted-2 hover:text-ink disabled:cursor-not-allowed"
                disabled={busy}
                onClick={() => void removeLabel(label.key)}
                type="button"
              >
                <X aria-hidden size={12} strokeWidth={2} />
              </button>
            </span>
          ))
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="w-[200px]">
          <label className={SECTION_LABEL_CLASS} htmlFor={`add-label-${orgId}`}>
            Add label
          </label>
          <Dropdown
            id={`add-label-${orgId}`}
            className="w-full"
            value={selectedKey}
            disabled={busy || addableKeys.length === 0}
            onChange={(event) => setSelectedKey(event.target.value)}
          >
            <option value="">
              {addableKeys.length === 0 ? "All known labels applied" : "Select a label..."}
            </option>
            {addableKeys.map((key) => (
              <option key={key} value={key}>
                {orgLabelDisplay(key).label}
              </option>
            ))}
          </Dropdown>
        </div>
        <Button
          disabled={busy || selectedKey === ""}
          onClick={() => void addLabel()}
          type="button"
          variant="primary"
        >
          Add label
        </Button>
      </div>
      <div className="mt-4 border-t border-line pt-3">
        <p className={SECTION_LABEL_CLASS}>YC launch grant</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-[120px]">
            <label className={SECTION_LABEL_CLASS} htmlFor={`yc-amount-${orgId}`}>
              Amount (USD)
            </label>
            <input
              className={ADMIN_INPUT_CLASS}
              id={`yc-amount-${orgId}`}
              inputMode="decimal"
              onChange={(event) => setYcAmount(event.target.value)}
              type="number"
              value={ycAmount}
            />
          </div>
          <div className="w-[170px]">
            <label className={SECTION_LABEL_CLASS} htmlFor={`yc-expiry-${orgId}`}>
              Expires
            </label>
            <input
              className={ADMIN_INPUT_CLASS}
              id={`yc-expiry-${orgId}`}
              onChange={(event) => setYcExpiry(event.target.value)}
              type="date"
              value={ycExpiry}
            />
          </div>
          <Button disabled={busy} onClick={() => void applyYcGrant()} type="button" variant="primary">
            Apply YC grant
          </Button>
        </div>
        <p className="m-0 mt-1.5 text-[11px] text-muted-2">
          Marks the org a YC company (applies the <code>yc</code> tag) and grants the amount,
          expiring on the date. Idempotent — safe to re-run.
        </p>
      </div>
      {error && <p className="m-0 mt-3 text-[13px] text-danger">{error}</p>}
    </Card>
  );
}

/**
 * The re-triggerable welcome celebration control: arm the confetti + API-key +
 * integration-prompt modal to re-show on this org's members' next workspace
 * enter, choosing the announced credit figure and whether to surface the API
 * key. Arming re-shows it even for members who saw a prior activation; the
 * amount is optional (blank falls back to the org's launch grant at display).
 */
function WelcomeTriggerSection({
  orgId,
  trigger
}: {
  orgId: string;
  trigger: WelcomeTriggerView | null;
}) {
  // Seed from the org's PERSISTED trigger, not fabricated defaults — otherwise
  // the card misreports state and a save silently overwrites the stored amount
  // and key flag. A never-armed org (null) starts disarmed with a blank amount.
  const [active, setActive] = useState(trigger?.active ?? false);
  const [amount, setAmount] = useState(
    trigger?.display_credit_usd != null ? String(trigger.display_credit_usd) : ""
  );
  const [showApiKey, setShowApiKey] = useState(trigger?.show_api_key ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(nextActive: boolean) {
    if (busy) {
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const parsed = Number(amount);
      const response = await fetch(`/api/admin/orgs/${orgId}/welcome-trigger`, {
        body: JSON.stringify({
          active: nextActive,
          display_credit_usd: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
          show_api_key: showApiKey
        }),
        headers: { "content-type": "application/json" },
        method: "PUT"
      });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to update the welcome celebration."));
        return;
      }
      setActive(nextActive);
      setNotice(
        nextActive
          ? "Armed — members see the celebration on their next workspace enter."
          : "Disarmed."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="m-0 mb-1 text-sm font-semibold text-ink">Welcome celebration</h2>
      <p className="m-0 mb-3 text-[11px] text-muted-2">
        Re-show the confetti + API key + integration-prompt modal on members' next enter.
        Arming again re-shows it even to members who already saw it.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-[140px]">
          <label className={SECTION_LABEL_CLASS} htmlFor={`welcome-amount-${orgId}`}>
            Credits to show (USD)
          </label>
          <input
            className={ADMIN_INPUT_CLASS}
            id={`welcome-amount-${orgId}`}
            inputMode="decimal"
            onChange={(event) => setAmount(event.target.value)}
            placeholder="Launch grant"
            type="number"
            value={amount}
          />
        </div>
        <label className="mb-2 flex items-center gap-1.5 text-[12.5px] text-ink">
          <input
            checked={showApiKey}
            onChange={(event) => setShowApiKey(event.target.checked)}
            type="checkbox"
          />
          Show API key
        </label>
        <Button disabled={busy} onClick={() => void save(true)} type="button" variant="primary">
          Arm celebration
        </Button>
        <Button disabled={busy} onClick={() => void save(false)} type="button">
          Disarm
        </Button>
      </div>
      <p className="m-0 mt-1.5 text-[11px] text-muted-2">
        Leave the amount blank to announce the org's launch grant. Current state:{" "}
        {active ? "armed" : "disarmed"}.
      </p>
      {error && <p className="m-0 mt-3 text-[13px] text-danger">{error}</p>}
      {notice && <p className="m-0 mt-3 text-[13px] text-muted">{notice}</p>}
    </Card>
  );
}

/**
 * The org's internal admin notes: author-attributed, newest first, add and
 * delete. Only platform admins ever reach this surface (the whole page is
 * admin-gated); the note author is the acting admin, resolved server-side.
 */
function OrgNotesSection({ orgId, timeZone }: { orgId: string; timeZone: string }) {
  const [notes, setNotes] = useState<OrgAdminNote[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<OrgAdminNote | null>(null);

  const refetch = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/orgs/${orgId}/notes`, { cache: "no-store" });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to load notes."));
        return;
      }
      const payload = (await response.json()) as { notes: OrgAdminNote[] };
      setNotes(payload.notes ?? []);
    } catch {
      setError("Unable to load notes.");
    }
  }, [orgId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  async function addNote() {
    const body = draft.trim();
    if (body === "" || busy) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/orgs/${orgId}/notes`, {
        body: JSON.stringify({ body }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to add the note."));
        return;
      }
      setDraft("");
      await refetch();
    } finally {
      setBusy(false);
    }
  }

  async function deleteNote(note: OrgAdminNote) {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/orgs/${orgId}/notes/${encodeURIComponent(note.id)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to delete the note."));
        return;
      }
      await refetch();
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  }

  return (
    <Card className="pb-6">
      <h2 className="m-0 mb-3 text-sm font-semibold text-ink">Admin notes</h2>
      <div className="flex flex-col gap-2">
        <textarea
          aria-label="New admin note"
          className={`${INPUT_CLASS} min-h-[64px] py-2`}
          maxLength={4000}
          placeholder="Internal note about this organization (admins only)"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button
            disabled={busy || draft.trim() === ""}
            onClick={() => void addNote()}
            type="button"
            variant="primary"
          >
            Add note
          </Button>
        </div>
      </div>
      {error && <p className="m-0 mt-3 text-[13px] text-danger">{error}</p>}
      <div className="mt-4 flex flex-col gap-3">
        {notes === null ? (
          <p className="m-0 text-[12.5px] text-muted-2">Loading...</p>
        ) : notes.length === 0 ? (
          <p className="m-0 text-[12.5px] text-muted">No notes yet.</p>
        ) : (
          notes.map((note) => (
            <div
              className="rounded-md border border-line bg-surface-subtle px-3 py-2"
              key={note.id}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-[12px] text-muted">
                  {note.author_email} · {formatDateTimeWithYear(note.created_at, timeZone)}
                </span>
                <button
                  aria-label="Delete note"
                  className="cursor-pointer text-muted-2 hover:text-danger disabled:cursor-not-allowed"
                  disabled={busy}
                  onClick={() => setPendingDelete(note)}
                  type="button"
                >
                  <X aria-hidden size={13} strokeWidth={2} />
                </button>
              </div>
              <p className="m-0 mt-1 whitespace-pre-wrap text-[13px] text-ink">{note.body}</p>
            </div>
          ))
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this note?"
        body="This internal note will be removed for all admins. This cannot be undone."
        confirmLabel="Delete note"
        busyLabel="Deleting..."
        busy={busy}
        tone="danger"
        confirmVariant="destructive"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete !== null) {
            void deleteNote(pendingDelete);
          }
        }}
      />
    </Card>
  );
}
