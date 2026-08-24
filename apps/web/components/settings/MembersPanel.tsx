"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { INVITE_ROLES } from "@/lib/admin/invites";
import type { OrgPendingInvite, OrgRosterMember } from "@/lib/members/manage";
import type { PendingJoinRequest } from "@/lib/org-join/types";
import { readApiError } from "@/components/world-models/wm-client";

const INPUT_CLASS =
  "min-h-[34px] rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";
const SELECT_CLASS =
  "min-h-[30px] rounded-[var(--radius-md)] border border-line-strong bg-surface px-2 text-[12px] text-ink focus:outline-none focus:border-[#bdbdbd]";
const ACTION_CLASS =
  "inline-flex items-center rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 py-1.5 text-[12px] cursor-pointer hover:border-[#bdbdbd] disabled:cursor-not-allowed disabled:opacity-55";

type InviteFallback = { email: string; reason: string; url: string };

/**
 * The two-way busy gate between the panel and an injected account-actions
 * slot, so one member row can never run two mutations at once: `disabled`
 * tells the slot a panel mutation is in flight; `onBusyChange` lets the slot
 * report its own, which gates the panel's controls.
 */
export type AccountActionsSlotControls = {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
};

type MembersPanelProps<M extends OrgRosterMember> = {
  orgId: string;
  members: M[];
  invites: OrgPendingInvite[];
  /**
   * Pending domain-based access requests for org admins to approve or deny.
   * Empty for plain members (the backend only lists them to admins).
   */
  joinRequests: PendingJoinRequest[];
  canManage: boolean;
  currentUserId: string;
  /**
   * Experiential-admin extras rendered in each member's action cell (the
   * shared UserAccountActions: email edit, ban, admin toggle, deletion). Only
   * OrgAdminDetail passes it; the org settings surface never renders them.
   * Generic over the member row so the admin loader's richer member type
   * flows through without a lookup on the caller's side.
   */
  renderAccountActions?: (member: M, controls: AccountActionsSlotControls) => ReactNode;
};

/**
 * Member management for one organization: roster with role control, invite
 * flow with an email-fallback link, pending-invite revocation. Shared by
 * Settings > Members (org admins) and the experiential-admin panel.
 */
export function MembersPanel<M extends OrgRosterMember>({
  orgId,
  members,
  invites,
  joinRequests,
  canManage,
  currentUserId,
  renderAccountActions
}: MembersPanelProps<M>) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // True while the injected account-actions slot runs its own mutation; the
  // panel's controls lock so e.g. Remove cannot race Delete on one member.
  const [accountActionsBusy, setAccountActionsBusy] = useState(false);
  const locked = busyKey !== null || accountActionsBusy;
  const [draft, setDraft] = useState<{ email: string; role: string }>({
    email: "",
    role: "user"
  });
  const [fallback, setFallback] = useState<InviteFallback | null>(null);
  const [copiedFallback, setCopiedFallback] = useState(false);

  async function run(
    key: string,
    action: () => Promise<Response>,
    successNotice: string,
    // Also re-fetch on failure. Set for actions whose failure means the
    // server state changed under us (e.g. a join request another admin already
    // decided): a refresh drops the now-stale row so it can't be acted on again.
    refreshOnError = false
  ) {
    setError(null);
    setNotice(null);
    setBusyKey(key);
    try {
      const response = await action();
      if (!response.ok) {
        setError(await readApiError(response, "The operation failed."));
        if (refreshOnError) {
          router.refresh();
        }
        return;
      }
      setNotice(successNotice);
      router.refresh();
    } finally {
      setBusyKey(null);
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = draft.email.trim().toLowerCase();
    if (!email.includes("@") || locked) {
      return;
    }
    setError(null);
    setNotice(null);
    setFallback(null);
    setBusyKey("add");
    try {
      const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/members`, {
        body: JSON.stringify(draft),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to add the member."));
        return;
      }
      const payload = (await response.json()) as {
        action: "added" | "invited";
        email?: { sent: boolean; reason?: string };
        inviteUrl?: string | null;
      };
      if (payload.action === "added") {
        setNotice(`Added ${email} to the organization.`);
      } else if (payload.email?.sent) {
        setNotice(`Invite emailed to ${email}; they will be added after signing up.`);
      } else if (payload.inviteUrl) {
        setNotice(`Invite created for ${email}, but the email was not sent.`);
        setFallback({
          email,
          reason: payload.email?.reason ?? "email delivery is not configured",
          url: payload.inviteUrl
        });
      } else {
        setError(
          "The invite was created, but no delivery link was returned. Revoke it before retrying."
        );
        return;
      }
      setDraft({ email: "", role: draft.role });
      router.refresh();
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {canManage && (
        <form
          className="flex flex-wrap items-end gap-2 border border-line rounded-lg bg-surface p-[18px]"
          onSubmit={addMember}
        >
          <label className="flex min-w-[220px] flex-1 flex-col gap-1.5">
            <span className="text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Email
            </span>
            <input
              className={INPUT_CLASS}
              onChange={(event) => setDraft({ ...draft, email: event.target.value })}
              placeholder="teammate@company.com"
              required
              type="email"
              value={draft.email}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Role
            </span>
            <select
              className={SELECT_CLASS}
              onChange={(event) => setDraft({ ...draft, role: event.target.value })}
              value={draft.role}
            >
              {INVITE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={!draft.email.includes("@")}
            loading={busyKey === "add"}
            type="submit"
            variant="primary"
          >
            Add member
          </Button>
          <span className="basis-full text-[11px] text-muted-2">
            Existing accounts are added immediately; new people receive a signup invite.
          </span>
        </form>
      )}

      {fallback && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-warning-soft/40 px-[18px] py-2.5">
          <span className="text-[12px] text-muted">
            Email to {fallback.email} was not sent ({fallback.reason}). Share this signup link:
          </span>
          <input
            aria-label={`Signup link for ${fallback.email}`}
            className={`${INPUT_CLASS} min-w-[260px] flex-1 font-mono text-[11px]`}
            readOnly
            value={fallback.url}
          />
          <button
            className={ACTION_CLASS}
            onClick={() => {
              void navigator.clipboard.writeText(fallback.url).then(() => {
                setCopiedFallback(true);
                window.setTimeout(() => setCopiedFallback(false), 1500);
              });
            }}
            type="button"
          >
            {copiedFallback ? "Copied" : "Copy link"}
          </button>
        </div>
      )}

      {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
      {notice && <p className="m-0 text-[13px] text-muted">{notice}</p>}

      {canManage && joinRequests.length > 0 && (
        <section className="border border-line rounded-lg bg-surface">
          <div className="flex items-center justify-between border-b border-line px-[18px] py-3">
            <span className="text-muted text-[12px]">
              {joinRequests.length} access request{joinRequests.length === 1 ? "" : "s"}
            </span>
            <span className="text-[11px] text-muted-2">
              People who signed up with your organization&apos;s email domain
            </span>
          </div>
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              {joinRequests.map((request) => {
                const requestKey = `join:${request.id}`;
                return (
                  <tr className="border-t border-line first:border-t-0" key={request.id}>
                    <td className="px-[18px] py-2.5">
                      <span className="font-mono">{request.email}</span>
                    </td>
                    <td className="px-2 py-2.5">
                      <div className="flex items-center justify-end gap-2 pr-2">
                        <button
                          className={ACTION_CLASS}
                          disabled={locked}
                          onClick={() =>
                            void run(
                              requestKey,
                              () =>
                                fetch(
                                  `/api/orgs/${encodeURIComponent(orgId)}/join-requests/${encodeURIComponent(request.id)}/approve`,
                                  { method: "POST" }
                                ),
                              `Granted ${request.email} access to the organization.`,
                              true
                            )
                          }
                          type="button"
                        >
                          Approve
                        </button>
                        <button
                          className={ACTION_CLASS}
                          disabled={locked}
                          onClick={() =>
                            void run(
                              requestKey,
                              () =>
                                fetch(
                                  `/api/orgs/${encodeURIComponent(orgId)}/join-requests/${encodeURIComponent(request.id)}/deny`,
                                  { method: "POST" }
                                ),
                              `Denied ${request.email}'s access request.`,
                              true
                            )
                          }
                          type="button"
                        >
                          Deny
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section className="border border-line rounded-lg bg-surface">
        <div className="flex items-center justify-between border-b border-line px-[18px] py-3">
          <span className="text-muted text-[12px]">
            {members.length} member{members.length === 1 ? "" : "s"}
          </span>
        </div>
        <table className="w-full border-collapse text-[13px]">
          <tbody>
            {members.map((member) => {
              const memberKey = `member:${member.userId}`;
              const isSelf = member.userId === currentUserId;
              return (
                <tr className="border-t border-line first:border-t-0" key={member.userId}>
                  <td className="px-[18px] py-2.5">
                    <span className="font-mono">{member.email ?? member.userId}</span>
                    {isSelf && <span className="ml-1.5 text-[11px] text-muted-2">you</span>}
                    {member.isExperientialAdmin && (
                      <span className="ml-1.5 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                        experiential admin
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2.5">
                    {canManage ? (
                      <select
                        aria-label={`Role for ${member.email ?? member.userId}`}
                        className={SELECT_CLASS}
                        disabled={locked}
                        onChange={(event) =>
                          void run(
                            memberKey,
                            () =>
                              fetch(
                                `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(member.userId)}`,
                                {
                                  body: JSON.stringify({ role: event.target.value }),
                                  headers: { "content-type": "application/json" },
                                  method: "PATCH"
                                }
                              ),
                            `Role updated for ${member.email ?? member.userId}.`
                          )
                        }
                        value={member.role}
                      >
                        {INVITE_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="rounded-full bg-foreground/[0.05] px-2 py-1 text-[11px] text-muted">
                        {member.role}
                      </span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-2 py-2.5">
                      <div className="flex items-center justify-end gap-2 pr-2">
                        {renderAccountActions?.(member, {
                          disabled: busyKey !== null,
                          onBusyChange: setAccountActionsBusy
                        })}
                        <button
                          className={`${ACTION_CLASS} text-danger hover:border-danger/40`}
                          disabled={locked}
                          onClick={() => {
                            if (
                              window.confirm(
                                isSelf
                                  ? "Remove yourself from this organization? You will lose access to it."
                                  : `Remove ${member.email ?? member.userId} from this organization? Their account and other memberships survive.`
                              )
                            ) {
                              void run(
                                `remove:${member.userId}`,
                                () =>
                                  fetch(
                                    `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(member.userId)}`,
                                    { method: "DELETE" }
                                  ),
                                `Removed ${member.email ?? member.userId} from the organization.`
                              );
                            }
                          }}
                          type="button"
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {canManage && invites.length > 0 && (
        <section className="border border-line rounded-lg bg-surface">
          <div className="flex items-center justify-between border-b border-line px-[18px] py-3">
            <span className="text-muted text-[12px]">
              {invites.length} pending invite{invites.length === 1 ? "" : "s"}
            </span>
          </div>
          <table className="w-full border-collapse text-[13px]">
            <tbody>
              {invites.map((invite) => (
                <tr className="border-t border-line first:border-t-0" key={invite.id}>
                  <td className="px-[18px] py-2.5 font-mono">{invite.email}</td>
                  <td className="px-2 py-2.5">
                    <span className="rounded-full bg-foreground/[0.05] px-2 py-1 text-[11px] text-muted">
                      {invite.role}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 text-muted-2 text-[12px]">
                    expires {formatDate(invite.expiresAt)}
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <button
                      className={`${ACTION_CLASS} mr-2`}
                      disabled={locked}
                      onClick={() =>
                        void run(
                          `revoke:${invite.id}`,
                          () =>
                            fetch(
                              `/api/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(invite.id)}`,
                              { method: "DELETE" }
                            ),
                          `Invite for ${invite.email} revoked.`
                        )
                      }
                      type="button"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}
