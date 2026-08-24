"use client";

import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { readApiError } from "@/components/world-models/wm-client";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LocalDateTime } from "@/components/ui/LocalDateTime";
import type { ScimKeyPolicy, ScimTokenMint, ScimTokenStatus } from "@/lib/scim";

const PILL_BUTTON =
  "rounded-full border border-line bg-background px-3 py-1 text-[12px] text-foreground/70 hover:text-foreground disabled:opacity-50";

const POLICY_LABEL: Record<ScimKeyPolicy, string> = {
  revoke: "Revoke their API keys",
  keep: "Keep their API keys"
};

/**
 * The org's SCIM provisioning credential: status, mint/rotate with the
 * one-time-secret banner (the token is hash-only server-side and never
 * re-displayed), revoke, and the IdP connection details.
 */
export function ScimTokenSection({
  orgId,
  scimBaseUrl
}: {
  orgId: string;
  scimBaseUrl: string;
}) {
  const [status, setStatus] = useState<ScimTokenStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [keyPolicy, setKeyPolicy] = useState<ScimKeyPolicy>("revoke");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const tokenPath = `/api/orgs/${encodeURIComponent(orgId)}/scim-token`;

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch(tokenPath);
      if (!response.ok) {
        setLoadError(await readApiError(response, "Unable to load the SCIM token status."));
        return;
      }
      const next = (await response.json()) as ScimTokenStatus;
      setStatus(next);
      setLoadError(null);
      if (next.key_policy !== null) {
        setKeyPolicy(next.key_policy);
      }
    } catch {
      setLoadError("Unable to load the SCIM token status.");
    }
  }, [tokenPath]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  async function mint() {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(tokenPath, {
        body: JSON.stringify({ key_policy: keyPolicy }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to create the SCIM token."));
        return;
      }
      const minted = (await response.json()) as ScimTokenMint;
      setMintedToken(minted.token);
      setCopied(false);
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(tokenPath, { method: "DELETE" });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to revoke the SCIM token."));
        return;
      }
      setConfirmingRevoke(false);
      setMintedToken(null);
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (mintedToken === null) {
      return;
    }
    await navigator.clipboard.writeText(mintedToken);
    setCopied(true);
  }

  const live = status !== null && status.exists && status.revoked_at === null;

  return (
    <div className="flex flex-col gap-4">
      {mintedToken !== null && (
        <div className="flex items-center justify-between gap-3 border border-line-strong rounded-lg bg-surface p-[18px]">
          <div className="min-w-0">
            <p className="m-0 mb-1 text-[13px] font-semibold text-ink">
              Copy your SCIM token now — it is shown only once.
            </p>
            <code className="block overflow-x-auto whitespace-nowrap font-mono text-[13px]">
              {mintedToken}
            </code>
            <p className="m-0 mt-2 text-[12px] text-muted">
              Paste it as the bearer token in your identity provider&apos;s SCIM
              configuration. Minting again rotates it and invalidates this one immediately.
            </p>
          </div>
          <button
            aria-label="Copy SCIM token"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-md)] border border-line bg-background text-foreground/60 hover:text-foreground"
            onClick={() => void copyToken()}
            type="button"
          >
            {copied ? <Check aria-hidden size={14} /> : <Copy aria-hidden size={14} />}
          </button>
        </div>
      )}

      <div className="border border-line rounded-lg bg-surface p-[18px]">
        <p className="m-0 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
          Bearer token
        </p>
        {status === null && loadError === null && (
          <p className="m-0 mt-2 text-[13px] text-muted">Loading…</p>
        )}
        {loadError !== null && (
          <p className="m-0 mt-2 text-[13px] text-danger">{loadError}</p>
        )}
        {status !== null && !status.exists && (
          <p className="m-0 mt-2 max-w-[520px] text-[13px] text-muted leading-relaxed">
            No SCIM token yet. Generate one and paste it into your identity provider to
            let it provision and deprovision members of this organization.
          </p>
        )}
        {status !== null && status.exists && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
            <code className="font-mono">xplscim_…{status.last4}</code>
            {status.created_at !== null && (
              <span className="text-muted">
                created <LocalDateTime value={status.created_at} withYear />
              </span>
            )}
            {status.key_policy !== null && (
              <span className="text-muted">
                on deprovision: {POLICY_LABEL[status.key_policy].toLowerCase()}
              </span>
            )}
            {status.revoked_at !== null ? (
              <span className="text-danger">revoked</span>
            ) : (
              <button
                className={PILL_BUTTON}
                disabled={busy}
                onClick={() => setConfirmingRevoke(true)}
                type="button"
              >
                Revoke
              </button>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            When a user is deprovisioned
            <select
              className="rounded-[var(--radius-md)] border border-line bg-background px-3 py-2 text-[13px] text-ink focus:outline-none focus:border-line-strong"
              onChange={(event) => setKeyPolicy(event.target.value === "keep" ? "keep" : "revoke")}
              value={keyPolicy}
            >
              <option value="revoke">{POLICY_LABEL.revoke}</option>
              <option value="keep">{POLICY_LABEL.keep}</option>
            </select>
          </label>
          <button
            className="rounded-full bg-foreground px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void mint()}
            type="button"
          >
            {busy ? "Working…" : live ? "Rotate token" : "Generate token"}
          </button>
        </div>
        {error !== null && (
          <div className="mt-3 rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-[13px] text-danger">
            {error}
          </div>
        )}
      </div>

      <div className="border border-line rounded-lg bg-surface p-[18px]">
        <p className="m-0 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
          Identity provider setup
        </p>
        <p className="m-0 mt-2 max-w-[520px] text-[13px] text-muted leading-relaxed">
          In your IdP (Okta, Entra ID, …) create a SCIM 2.0 provisioning integration with
          this base URL and the bearer token above. User sync is supported; group sync is
          not yet available.
        </p>
        <code className="mt-2 block overflow-x-auto whitespace-nowrap font-mono text-[13px]">
          {scimBaseUrl}
        </code>
      </div>

      <ConfirmDialog
        body="Your identity provider will stop being able to provision or deprovision members until you generate a new token."
        busy={busy}
        busyLabel="Revoking…"
        confirmLabel="Revoke token"
        confirmVariant="destructive"
        error={error}
        onCancel={() => setConfirmingRevoke(false)}
        onConfirm={() => void revoke()}
        open={confirmingRevoke}
        title="Revoke the SCIM token?"
        tone="danger"
      />
    </div>
  );
}
