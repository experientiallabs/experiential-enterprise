"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LocalDateTime } from "@/components/ui/LocalDateTime";
import { readApiError } from "@/components/world-models/wm-client";
import type { SuperadminKeyRow } from "@/lib/admin/superadmin-keys";
import { formatKeyIdentity } from "@/lib/api-keys/format";

const HEADER_CELL = "px-[18px] py-3 font-medium";
const HEADER_ROW =
  "text-left text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase";
const PILL_BUTTON =
  "cursor-pointer rounded-full border border-line bg-transparent px-3 py-1 text-[12px] text-foreground/60 hover:border-line-strong hover:text-foreground disabled:cursor-not-allowed disabled:text-foreground/25 disabled:hover:border-line";

type SuperadminKeysPanelProps = {
  keys: SuperadminKeyRow[];
};

/**
 * The admin Access panel: list every superadmin key with a revoke action.
 * Keys are MINTED only when an operator is granted superadmin status (the
 * site-admin grant route), where the secret is revealed once to the granting
 * admin; this panel never creates keys. Platform-admin gated by the admin
 * layout above; revocation refreshes the server-rendered list.
 */
export function SuperadminKeysPanel({ keys }: SuperadminKeysPanelProps) {
  const router = useRouter();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<SuperadminKeyRow | null>(null);

  async function revokeKey(key: SuperadminKeyRow) {
    setError(null);
    setRevokingId(key.id);
    try {
      const response = await fetch(
        `/api/admin/superadmin-keys/${encodeURIComponent(key.id)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to revoke the key."));
        return;
      }
      router.refresh();
    } catch (thrown) {
      // The key is still LIVE if this failed; the operator must not walk away
      // believing a compromised credential was revoked.
      setError(
        `The revoke request failed (${
          thrown instanceof Error ? thrown.message : "network error"
        }); the key is still active. Retry until the row shows Revoked.`
      );
    } finally {
      setRevokingId(null);
      setPendingKey(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error !== null && (
        <div className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      )}

      <section className="rounded-lg border border-line bg-surface">
        {keys.length === 0 ? (
          <div className="flex items-center gap-3 p-[18px] text-[13px] text-muted">
            <KeyRound aria-hidden size={16} strokeWidth={1.8} />
            No superadmin keys. A key is minted when an operator is granted superadmin
            status on the Users page.
          </div>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className={HEADER_ROW}>
                <th className={HEADER_CELL}>Name</th>
                <th className={HEADER_CELL}>Key</th>
                <th className={HEADER_CELL}>Owner</th>
                <th className={HEADER_CELL}>Created</th>
                <th className={HEADER_CELL}>Last used</th>
                <th className={HEADER_CELL}>Status</th>
                <th className="px-[18px] py-3" />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr className="border-t border-line" key={key.id}>
                  <td className="px-[18px] py-3">{key.name}</td>
                  <td className="px-[18px] py-3 font-mono">
                    {formatKeyIdentity(key.key_prefix, key.key_suffix)}
                  </td>
                  {/* Durable attribution captured at mint: survives the
                      owner's account deletion, unlike user_id (SET NULL). */}
                  <td className="px-[18px] py-3 text-[12px] text-muted">
                    {key.owner_email}
                  </td>
                  <td className="px-[18px] py-3 text-muted">
                    <LocalDateTime value={key.created_at} withYear />
                  </td>
                  <td className="px-[18px] py-3 text-muted">
                    {key.last_used_at ? <LocalDateTime value={key.last_used_at} withYear /> : "Never"}
                  </td>
                  <td className="px-[18px] py-3">
                    {key.revoked_at !== null ? (
                      <span className="text-muted">Revoked</span>
                    ) : (
                      <span className="text-ink">Active</span>
                    )}
                  </td>
                  <td className="px-[18px] py-3 text-right">
                    {key.revoked_at === null && (
                      <button
                        className={PILL_BUTTON}
                        disabled={revokingId !== null}
                        onClick={() => setPendingKey(key)}
                        type="button"
                      >
                        {revokingId === key.id ? "Revoking…" : "Revoke"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <ConfirmDialog
        open={pendingKey !== null}
        title={
          pendingKey !== null
            ? `Revoke "${pendingKey.name}" (${formatKeyIdentity(pendingKey.key_prefix, pendingKey.key_suffix)})?`
            : ""
        }
        body="Machine callers using it stop authenticating immediately."
        confirmLabel="Revoke key"
        busyLabel="Revoking..."
        busy={revokingId !== null}
        tone="danger"
        confirmVariant="destructive"
        onCancel={() => setPendingKey(null)}
        onConfirm={() => {
          if (pendingKey !== null) {
            void revokeKey(pendingKey);
          }
        }}
      />
    </div>
  );
}
