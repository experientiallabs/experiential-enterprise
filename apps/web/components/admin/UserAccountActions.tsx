"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { readApiError } from "@/components/world-models/wm-client";
import { normalizeEmail } from "@/lib/email/address";

const INPUT_CLASS =
  "w-full min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";
const LABEL_CLASS =
  "mb-1.5 block text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/25";

export type UserAccountTarget = {
  id: string;
  email: string | null;
  /** A live ban record on the account (sign-in locked out). */
  banned: boolean;
  /** A row in platform_admins (the operator population). */
  isExperientialAdmin: boolean;
};

type UserAccountActionsProps = {
  user: UserAccountTarget;
  /**
   * The signed-in operator. Their own row hides ban and delete (the routes
   * refuse both with 409) and disables admin revoke with the lockout copy.
   */
  currentUserId: string;
  /** External busy gate: disables every action (a sibling mutation is in flight). */
  disabled?: boolean;
  /**
   * Fires when this component starts/finishes a mutation, so the hosting row
   * (MembersPanel on the org detail) can gate its own actions and not race a
   * remove-from-org against a delete-account on the same member.
   */
  onBusyChange?: (busy: boolean) => void;
};

type DialogKind = "email" | "ban";

/**
 * A confirm-then-act request routed through the shared ConfirmDialog: revoke
 * experiential admin, unban, delete, and grant. The caller owns `perform` (the
 * mutation) and the copy; `busyKey` gates the dialog's in-flight state.
 */
type PendingConfirm = {
  busyKey: string;
  title: string;
  body: string;
  confirmLabel: string;
  busyLabel: string;
  tone: "danger" | "warning";
  confirmVariant: "primary" | "destructive";
  perform: () => Promise<void>;
};

/**
 * The user-scoped admin actions, shared by the admin Users table and the org
 * detail's member roster so the two surfaces cannot drift: edit the account
 * email, ban/unban, grant/revoke experiential-admin status, delete the
 * account. Org-scoped controls (role, remove-from-org, invites) stay in
 * MembersPanel. Every action calls the /api/admin/users/{id} routes and
 * refreshes the surface on success; dialog actions surface failures in the
 * dialog, confirm-based ones inline below the buttons.
 */
export function UserAccountActions({
  user,
  currentUserId,
  disabled = false,
  onBusyChange
}: UserAccountActionsProps) {
  const router = useRouter();
  const isSelf = user.id === currentUserId;
  const label = user.email ?? user.id;

  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [banReason, setBanReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The superadmin key minted by a fresh grant: on screen until dismissed,
  // then gone for good (only its hash is stored).
  const [mintedSecret, setMintedSecret] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const locked = busyKey !== null || disabled;

  function setBusy(key: string | null) {
    setBusyKey(key);
    onBusyChange?.(key !== null);
  }

  function openDialog(kind: DialogKind) {
    setEmailDraft(user.email ?? "");
    setBanReason("");
    setDialogError(null);
    setDialog(kind);
  }

  async function runAction(
    key: string,
    request: () => Promise<Response>,
    fallback: string
  ) {
    setError(null);
    setBusy(key);
    try {
      const response = await request();
      if (!response.ok) {
        setError(await readApiError(response, fallback));
        return;
      }
      router.refresh();
    } catch (thrown) {
      // A mid-flight failure leaves the outcome unknown; the operator must
      // not walk away assuming the action landed.
      setError(
        `The request failed (${
          thrown instanceof Error ? thrown.message : "network error"
        }); it may not have been applied. Refresh and retry.`
      );
      router.refresh();
    } finally {
      setBusy(null);
      setPendingConfirm(null);
    }
  }

  // Grant is not runAction: a fresh grant's response carries the one-time
  // superadmin key secret, which must be revealed before it is lost forever.
  async function grantAdmin() {
    setError(null);
    setBusy("site-admin");
    try {
      const response = await fetch(`/api/admin/users/${user.id}/site-admin`, { method: "PUT" });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to grant experiential-admin access."));
        return;
      }
      const payload = (await response.json()) as {
        key?: { name: string; secret: string };
        mintError?: string;
      };
      if (payload.key) {
        setMintedSecret(payload.key.secret);
        setCopiedSecret(false);
      }
      if (payload.mintError) {
        setError(payload.mintError);
      }
      router.refresh();
    } catch (thrown) {
      // The dangerous case: the grant may have SUCCEEDED server-side (the
      // connection dropped reading the body), leaving a live key whose
      // plaintext nobody saw. Say so explicitly.
      setError(
        `The grant request failed mid-flight (${
          thrown instanceof Error ? thrown.message : "network error"
        }). The grant may have applied and a key been minted. To recover a usable key, revoke this account's experiential-admin status and grant it again: a plain retry mints nothing because the grant is already in place. Check Admin, Access first and revoke any unrecognized key.`
      );
      router.refresh();
    } finally {
      setBusy(null);
      setPendingConfirm(null);
    }
  }

  async function copyMintedSecret() {
    if (mintedSecret === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(mintedSecret);
      setCopiedSecret(true);
    } catch {
      // Clipboard permission denied: the secret is still on screen. Never
      // flip the copied state on failure.
      setError("Clipboard copy was blocked by the browser. Select and copy the key manually.");
    }
  }

  async function confirmEmailEdit() {
    const email = normalizeEmail(emailDraft);
    if (email === null) {
      setDialogError("Enter a valid email address.");
      return;
    }
    setDialogError(null);
    setBusy("email");
    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        body: JSON.stringify({ email }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      });
      if (!response.ok) {
        setDialogError(await readApiError(response, "Unable to change the email."));
        return;
      }
      setDialog(null);
      router.refresh();
    } catch (thrown) {
      setDialogError(
        `The request failed (${
          thrown instanceof Error ? thrown.message : "network error"
        }); the email may be unchanged. Retry.`
      );
    } finally {
      setBusy(null);
    }
  }

  async function confirmBan() {
    const reason = banReason.trim();
    if (reason.length === 0) {
      setDialogError("A reason is required to ban an account.");
      return;
    }
    setDialogError(null);
    setBusy("ban");
    try {
      const response = await fetch(`/api/admin/users/${user.id}/ban`, {
        body: JSON.stringify({ reason }),
        headers: { "content-type": "application/json" },
        method: "PUT"
      });
      if (!response.ok) {
        setDialogError(await readApiError(response, "Unable to ban the account."));
        return;
      }
      setDialog(null);
      router.refresh();
    } catch (thrown) {
      setDialogError(
        `The request failed (${
          thrown instanceof Error ? thrown.message : "network error"
        }); the ban may not have been applied. Retry.`
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button disabled={locked} onClick={() => openDialog("email")} size="sm" type="button">
          Edit email
        </Button>

        {isSelf ? (
          user.isExperientialAdmin ? (
            <span className="inline-flex flex-col items-end gap-0.5">
              <Button disabled size="sm" type="button">
                Revoke experiential admin
              </Button>
              <span className="text-[11px] text-muted-2">
                You cannot revoke your own access. Another operator must do it.
              </span>
            </span>
          ) : null
        ) : (
          <>
            {user.isExperientialAdmin ? (
              <Button
                disabled={locked}
                onClick={() =>
                  setPendingConfirm({
                    busyKey: "site-admin",
                    title: `Revoke experiential-admin access for ${label}?`,
                    body: "Their superadmin API keys stop working immediately and they lose the admin surface. They keep their organization memberships.",
                    confirmLabel: "Revoke access",
                    busyLabel: "Revoking...",
                    tone: "danger",
                    confirmVariant: "destructive",
                    perform: () =>
                      runAction(
                        "site-admin",
                        () => fetch(`/api/admin/users/${user.id}/site-admin`, { method: "DELETE" }),
                        "Unable to revoke experiential-admin access."
                      )
                  })
                }
                size="sm"
                type="button"
              >
                Revoke experiential admin
              </Button>
            ) : user.banned ? null : (
              // No grant on a banned row: the route refuses it (a grant would
              // mint a working machine credential for a locked-out account).
              <Button
                disabled={locked}
                onClick={() =>
                  setPendingConfirm({
                    busyKey: "site-admin",
                    title: `Make ${label} an experiential admin?`,
                    body: "They get operator access to every organization and the full admin surface, and a superadmin API key is minted for them and shown to you once.",
                    confirmLabel: "Grant access",
                    busyLabel: "Granting...",
                    tone: "warning",
                    confirmVariant: "primary",
                    perform: grantAdmin
                  })
                }
                size="sm"
                type="button"
              >
                Make experiential admin
              </Button>
            )}

            {user.banned ? (
              <Button
                disabled={locked}
                onClick={() =>
                  setPendingConfirm({
                    busyKey: "ban",
                    title: `Unban ${label}?`,
                    body: "They will be able to sign in again. API keys revoked at ban time stay revoked.",
                    confirmLabel: "Unban account",
                    busyLabel: "Unbanning...",
                    tone: "warning",
                    confirmVariant: "primary",
                    perform: () =>
                      runAction(
                        "ban",
                        () => fetch(`/api/admin/users/${user.id}/ban`, { method: "DELETE" }),
                        "Unable to unban the account."
                      )
                  })
                }
                size="sm"
                type="button"
              >
                Unban
              </Button>
            ) : (
              <Button
                disabled={locked}
                onClick={() => openDialog("ban")}
                size="sm"
                type="button"
                variant="destructive"
              >
                Ban
              </Button>
            )}

            <Button
              disabled={locked}
              onClick={() =>
                setPendingConfirm({
                  busyKey: "delete",
                  title: `Delete the account ${label} from authentication and every organization?`,
                  body: "This cannot be undone.",
                  confirmLabel: "Delete account",
                  busyLabel: "Deleting...",
                  tone: "danger",
                  confirmVariant: "destructive",
                  perform: () =>
                    runAction(
                      "delete",
                      () => fetch(`/api/admin/users/${user.id}`, { method: "DELETE" }),
                      "Unable to delete the account."
                    )
                })
              }
              size="sm"
              type="button"
              variant="destructive"
            >
              Delete
            </Button>
          </>
        )}
      </div>

      {error && <p className="m-0 text-right text-[12px] text-danger">{error}</p>}

      <ConfirmDialog
        open={dialog === "email"}
        title={`Change the email for ${label}?`}
        body="Sign-in and notifications move to the new address immediately and the new address counts as verified. No confirmation email is sent to the old or the new address."
        confirmLabel="Save email"
        busyLabel="Saving..."
        busy={busyKey === "email"}
        error={dialogError}
        onCancel={() => setDialog(null)}
        onConfirm={() => void confirmEmailEdit()}
      >
        <label className="mt-4 block">
          <span className={LABEL_CLASS}>
            New email address
          </span>
          <input
            aria-label="New email address"
            className={INPUT_CLASS}
            maxLength={320}
            type="email"
            value={emailDraft}
            onChange={(event) => setEmailDraft(event.target.value)}
          />
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === "ban"}
        title={`Ban ${label}?`}
        body="Banning blocks every sign-in method, signs the user out everywhere, and revokes the API keys they created. Keys other organization members created are untouched. Unbanning restores sign-in but never un-revokes keys."
        confirmLabel="Ban account"
        busyLabel="Banning..."
        busy={busyKey === "ban"}
        tone="danger"
        confirmVariant="destructive"
        error={dialogError}
        onCancel={() => setDialog(null)}
        onConfirm={() => void confirmBan()}
      >
        <label className="mt-4 block">
          <span className={LABEL_CLASS}>
            Reason (required)
          </span>
          <textarea
            aria-label="Ban reason"
            className={`${INPUT_CLASS} min-h-[64px] py-2`}
            maxLength={500}
            placeholder="Why this account is being banned"
            value={banReason}
            onChange={(event) => setBanReason(event.target.value)}
          />
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title ?? ""}
        body={pendingConfirm?.body ?? ""}
        confirmLabel={pendingConfirm?.confirmLabel ?? ""}
        busyLabel={pendingConfirm?.busyLabel ?? ""}
        busy={pendingConfirm !== null && busyKey === pendingConfirm.busyKey}
        tone={pendingConfirm?.tone ?? "warning"}
        confirmVariant={pendingConfirm?.confirmVariant ?? "primary"}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          if (pendingConfirm !== null) {
            void pendingConfirm.perform();
          }
        }}
      />

      {mintedSecret !== null && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-6">
          <section
            aria-label={`Superadmin key for ${label}`}
            aria-modal="true"
            className="w-full max-w-[520px] rounded-[var(--radius-lg)] border border-line bg-surface p-[18px] shadow-[0_18px_50px_rgba(20,20,18,0.14)]"
            role="dialog"
          >
            <h2 className="m-0 text-[15px] font-semibold text-ink">
              Superadmin key for {label}
            </h2>
            <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-muted">
              Copy it now and hand it over securely. It is shown only once and only its hash
              is stored; it can be revoked from Admin, Access.
            </p>
            <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-line-strong bg-background p-3">
              <code className="block overflow-x-auto whitespace-nowrap font-mono text-[13px]">
                {mintedSecret}
              </code>
              <button
                aria-label="Copy superadmin key"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-md)] border border-line bg-surface text-foreground/60 hover:text-foreground"
                onClick={() => void copyMintedSecret()}
                type="button"
              >
                {copiedSecret ? <Check aria-hidden size={14} /> : <Copy aria-hidden size={14} />}
              </button>
            </div>
            <div className="mt-5 flex justify-end">
              <Button onClick={() => setMintedSecret(null)} type="button" variant="primary">
                Done
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
