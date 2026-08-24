"use client";

// KeyHub's org API keys section: the gateway bearer keys table plus the mint
// flow with its one-time secret display. Semantics are exactly the shipped
// panel's (many keys, plaintext shown once, soft revoke); the data now comes
// through the shared KeyHub store over GET /api/keys, so this section mounts
// unchanged on settings, the model page, and the Overview, and a key minted
// on any mount appears on the others without a reload.

import { Fragment, useState, type FormEvent } from "react";
import { Check, Copy, KeyRound } from "lucide-react";

import { useLoginModal } from "@/components/auth/login-modal-context";
import {
  mintOrgApiKey,
  revokeOrgApiKey,
  rotateOrgApiKey,
  saveKeyLimits,
  useKeyLimits,
  useOrgApiKeys
} from "@/components/keys/store";
import { Button } from "@/components/ui/Button";
import { LocalDateTime } from "@/components/ui/LocalDateTime";
import { Shimmer } from "@/components/ui/Shimmer";
import { formatKeyIdentity } from "@/lib/api-keys/format";
import { API_KEY_EXPIRY_DAYS, type ApiKeyRow } from "@/lib/api-keys/types";

export type OrgApiKeysSectionProps = {
  /** UUID of the org whose keys are shown; null renders the signed-out state (no fetches fire). */
  orgId: string | null;
  canManage: boolean;
  /**
   * Scope the section to one identity's keys and mint under it. Omitted (null)
   * keeps the org-wide behavior the settings/model/overview mounts rely on.
   */
  identityId?: string | null;
};

const HEADER_CELL = "px-[18px] py-3 font-medium";
const HEADER_ROW = "text-left text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase";
const PILL_BUTTON =
  "cursor-pointer rounded-full border border-line bg-transparent px-3 py-1 text-[12px] text-foreground/60 hover:border-line-strong hover:text-foreground disabled:cursor-not-allowed disabled:text-foreground/25 disabled:hover:border-line";

export function OrgApiKeysSection({ orgId, canManage, identityId = null }: OrgApiKeysSectionProps) {
  const { open, requireAuth } = useLoginModal();
  const [page, setPage] = useState(1);
  const [showRevoked, setShowRevoked] = useState(false);
  // The one key whose limits row is expanded; toggled per row below.
  const [limitsKeyId, setLimitsKeyId] = useState<string | null>(null);
  const keysPage = useOrgApiKeys(orgId, page, showRevoked, identityId);

  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
  const [mintedSecret, setMintedSecret] = useState<string | null>(null);
  // Set alongside mintedSecret when the secret came from a rotation: the
  // banner then also says how long the outgoing key keeps working.
  const [rotatedFromExpiry, setRotatedFromExpiry] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The key whose rotate call is in flight; its row actions disable meanwhile.
  const [rotatingKeyId, setRotatingKeyId] = useState<string | null>(null);

  if (orgId === null) {
    // The signed-out settings-style locked state (design doc "Locked
    // sections"): the frame renders, one line says what lives here, one
    // sign-in action. TODO(shell): swap this inline card for the shared
    // <LockedSection> when the app-shell workstream ships it.
    return (
      <section className="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface p-[18px]">
        <div className="flex items-center gap-3 text-[13px] text-muted">
          <KeyRound aria-hidden className="shrink-0" size={16} strokeWidth={1.8} />
          API keys for calling the gateway live here.
        </div>
        <Button onClick={open} size="sm" type="button" variant="primary">
          Sign in
        </Button>
      </section>
    );
  }

  // Narrowed once so the async closures below see a plain string.
  const org = orgId;

  function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    requireAuth(() => {
      void (async () => {
        setError(null);
        setIsSubmitting(true);
        try {
          const result = await mintOrgApiKey(org, name, expiresInDays, identityId);
          if ("error" in result) {
            setError(result.error);
            return;
          }
          setMintedSecret(result.minted.secret);
          setRotatedFromExpiry(null);
          setCopied(false);
          setName("");
          // The freshest key sorts first, so land on page one of the active view.
          setPage(1);
          setShowRevoked(false);
        } finally {
          setIsSubmitting(false);
        }
      })();
    });
  }

  function revokeKey(keyId: string) {
    requireAuth(() => {
      void (async () => {
        setError(null);
        const failure = await revokeOrgApiKey(org, keyId);
        if (failure !== null) {
          setError(failure.error);
        }
      })();
    });
  }

  // Rotation: a same-named replacement is minted and the OLD key keeps
  // working through the server's 24h overlap window, so services can roll to
  // the new secret without an outage. The replacement's plaintext reuses the
  // mint flow's one-time banner.
  function rotateKey(keyId: string) {
    requireAuth(() => {
      void (async () => {
        setError(null);
        setRotatingKeyId(keyId);
        try {
          const result = await rotateOrgApiKey(org, keyId);
          if ("error" in result) {
            setError(result.error);
            return;
          }
          setMintedSecret(result.rotated.secret);
          setRotatedFromExpiry(result.rotated.oldKeyExpiresAt);
          setCopied(false);
          // The replacement sorts first, so land on page one of the active view.
          setPage(1);
          setShowRevoked(false);
        } finally {
          setRotatingKeyId(null);
        }
      })();
    });
  }

  async function copySecret() {
    if (mintedSecret === null) {
      return;
    }
    await navigator.clipboard.writeText(mintedSecret);
    setCopied(true);
  }

  const keys = keysPage.data?.keys ?? [];
  const total = keysPage.data?.total ?? 0;
  const pageCount = keysPage.data?.pageCount ?? 1;
  const currentPage = keysPage.data?.page ?? page;

  return (
    <div className="flex flex-col gap-4">
      {canManage && (
        <form
          className="flex items-end gap-3 border border-line rounded-lg bg-surface p-[18px]"
          onSubmit={createKey}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Key name
            </span>
            <input
              className="w-full max-w-[360px] rounded-[var(--radius-md)] border border-line bg-background px-3 py-2 text-[13px] focus:outline-none focus:border-line-strong"
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. production-server"
              required
              value={name}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
              Expires
            </span>
            <select
              className="rounded-[var(--radius-md)] border border-line bg-background px-3 py-2 text-[13px] focus:outline-none focus:border-line-strong"
              onChange={(event) =>
                setExpiresInDays(event.target.value === "" ? null : Number(event.target.value))
              }
              value={expiresInDays ?? ""}
            >
              <option value="">Never</option>
              {API_KEY_EXPIRY_DAYS.map((days) => (
                <option key={days} value={days}>
                  In {days} days
                </option>
              ))}
            </select>
          </label>
          <button
            className="rounded-full bg-foreground px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-foreground/85 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? "Creating…" : "Create key"}
          </button>
        </form>
      )}

      {mintedSecret !== null && (
        <div className="flex items-center justify-between gap-3 border border-line-strong rounded-lg bg-surface p-[18px]">
          <div className="min-w-0">
            <p className="m-0 mb-1 text-[13px] font-semibold text-ink">
              Copy your key now — it is shown only once.
            </p>
            <code className="block overflow-x-auto whitespace-nowrap font-mono text-[13px]">
              {mintedSecret}
            </code>
            {rotatedFromExpiry !== null && (
              <p className="m-0 mt-2 text-[12px] text-muted">
                The previous key keeps working until{" "}
                <LocalDateTime value={rotatedFromExpiry} withYear /> — switch your services over
                before then.
              </p>
            )}
          </div>
          <button
            aria-label="Copy API key"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-md)] border border-line bg-background text-foreground/60 hover:text-foreground"
            onClick={copySecret}
            type="button"
          >
            {copied ? <Check aria-hidden size={14} /> : <Copy aria-hidden size={14} />}
          </button>
        </div>
      )}

      {error !== null && (
        <div className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      )}

      <section className="border border-line rounded-lg bg-surface">
        <div className="flex items-center justify-between border-b border-line px-[18px] py-3">
          <span className="text-muted text-[12px]">
            {keysPage.data === null
              ? "Loading keys…"
              : `${total} ${showRevoked ? (total === 1 ? "key" : "keys") : total === 1 ? "active key" : "active keys"}`}
          </span>
          <button
            className={PILL_BUTTON}
            onClick={() => {
              setShowRevoked((current) => !current);
              setPage(1);
            }}
            type="button"
          >
            {showRevoked ? "Hide revoked" : "Show revoked"}
          </button>
        </div>
        {keysPage.data === null && keysPage.error === null ? (
          <div className="flex flex-col gap-3 p-[18px]">
            <Shimmer className="h-4 w-full" />
            <Shimmer className="h-4 w-full" />
            <Shimmer className="h-4 w-2/3" />
          </div>
        ) : keysPage.data === null ? (
          <p className="m-0 p-[18px] text-[13px] text-danger">{keysPage.error}</p>
        ) : keys.length === 0 ? (
          <div className="flex items-center gap-3 p-[18px] text-muted text-[13px]">
            <KeyRound aria-hidden size={16} strokeWidth={1.8} />
            {showRevoked ? "No API keys yet" : "No active API keys"}
            {canManage ? " — create one to call the endpoints." : "."}
          </div>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className={HEADER_ROW}>
                <th className={HEADER_CELL}>Name</th>
                <th className={HEADER_CELL}>Key</th>
                <th className={HEADER_CELL}>Created</th>
                <th className={HEADER_CELL}>Last used</th>
                <th className={HEADER_CELL}>Expires</th>
                <th className={HEADER_CELL}>Status</th>
                {/* Actions: Limits for every member (the read is member-strength), Revoke for admins. */}
                <th className="px-[18px] py-3" />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <Fragment key={key.id}>
                  <tr className="border-t border-line">
                    <td className="px-[18px] py-3">{key.name}</td>
                    <td className="px-[18px] py-3 font-mono">
                      {formatKeyIdentity(key.key_prefix, key.key_suffix)}
                    </td>
                    <td className="px-[18px] py-3 text-muted">
                      <LocalDateTime value={key.created_at} withYear />
                    </td>
                    <td className="px-[18px] py-3 text-muted">
                      {key.last_used_at ? <LocalDateTime value={key.last_used_at} withYear /> : "Never"}
                    </td>
                    <td className="px-[18px] py-3 text-muted">
                      {key.expires_at ? <LocalDateTime value={key.expires_at} withYear /> : "Never"}
                    </td>
                    <td className="px-[18px] py-3">{statusLabel(key)}</td>
                    <td className="px-[18px] py-3 text-right">
                      {key.revoked_at === null && (
                        <div className="flex flex-wrap justify-end gap-2">
                          <button
                            aria-expanded={limitsKeyId === key.id}
                            className={PILL_BUTTON}
                            onClick={() =>
                              setLimitsKeyId((current) => (current === key.id ? null : key.id))
                            }
                            type="button"
                          >
                            {limitsKeyId === key.id ? "Hide limits" : "Limits"}
                          </button>
                          {canManage && (
                            <>
                              <button
                                aria-busy={rotatingKeyId === key.id}
                                className={PILL_BUTTON}
                                disabled={rotatingKeyId !== null}
                                onClick={() => rotateKey(key.id)}
                                type="button"
                              >
                                {rotatingKeyId === key.id ? "Rotating…" : "Rotate"}
                              </button>
                              <button
                                className={PILL_BUTTON}
                                disabled={rotatingKeyId !== null}
                                onClick={() => revokeKey(key.id)}
                                type="button"
                              >
                                Revoke
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                  {limitsKeyId === key.id && (
                    <tr className="border-t border-line">
                      <td className="px-[18px] py-4" colSpan={7}>
                        <KeyLimitsRow apiKeyId={key.id} canManage={canManage} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-line px-[18px] py-3 text-[12px]">
            <span className="text-muted">
              Page {currentPage} of {pageCount}
            </span>
            <div className="flex gap-2">
              <button
                className={PILL_BUTTON}
                disabled={currentPage <= 1}
                onClick={() => setPage(currentPage - 1)}
                type="button"
              >
                Previous
              </button>
              <button
                className={PILL_BUTTON}
                disabled={currentPage >= pageCount}
                onClick={() => setPage(currentPage + 1)}
                type="button"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function statusLabel(key: ApiKeyRow) {
  if (key.revoked_at !== null) {
    return <span className="text-muted">Revoked</span>;
  }
  if (key.expires_at !== null && new Date(key.expires_at).getTime() <= Date.now()) {
    return <span className="text-muted">Expired</span>;
  }
  return <span className="text-ink">Active</span>;
}

// -- Per-key limits (the expandable row) --------------------------------------

const LIMIT_INPUT =
  "w-full rounded-[var(--radius-md)] border border-line bg-background px-3 py-2 text-[13px] focus:outline-none focus:border-line-strong";

/**
 * One key's effective gateway guardrails, read through the shared store so
 * every mount of this section sees a save without a reload. Values render for
 * every member; editing is admin-only client-side, and a stale-role 403 from
 * the PUT still renders gracefully as the save error.
 */
function KeyLimitsRow({ apiKeyId, canManage }: { apiKeyId: string; canManage: boolean }) {
  const limits = useKeyLimits(apiKeyId);
  const [editing, setEditing] = useState(false);
  // Form fields as entered text; blank means uncapped. Money is edited in
  // dollars and converted to integer micro-USD only at submit.
  const [capDollars, setCapDollars] = useState("");
  const [requestsPerMinute, setRequestsPerMinute] = useState("");
  const [tokensPerMinute, setTokensPerMinute] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  if (limits.data === null && limits.error === null) {
    return <Shimmer className="h-4 w-2/3" />;
  }
  if (limits.data === null) {
    return <p className="m-0 text-[13px] text-danger">{limits.error}</p>;
  }
  const data = limits.data;

  function beginEdit() {
    setCapDollars(
      data.daily_spend_cap_micro_usd === null
        ? ""
        : String(data.daily_spend_cap_micro_usd / 1_000_000)
    );
    setRequestsPerMinute(data.requests_per_minute === null ? "" : String(data.requests_per_minute));
    setTokensPerMinute(data.tokens_per_minute === null ? "" : String(data.tokens_per_minute));
    setSaveError(null);
    setEditing(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cap = parseDollarsToMicroUsd(capDollars);
    const rpm = parsePerMinute(requestsPerMinute);
    const tpm = parsePerMinute(tokensPerMinute);
    if (cap === "invalid" || rpm === "invalid" || tpm === "invalid") {
      setSaveError(
        "Enter a dollar amount of $0 or more and whole per-minute counts above zero, or leave a field blank for uncapped."
      );
      return;
    }
    void (async () => {
      setSaveError(null);
      setIsSaving(true);
      try {
        // Always all three fields: the write replaces the whole row.
        const failure = await saveKeyLimits(apiKeyId, {
          daily_spend_cap_micro_usd: cap,
          requests_per_minute: rpm,
          tokens_per_minute: tpm
        });
        if (failure !== null) {
          setSaveError(failure.error);
          return;
        }
        setEditing(false);
      } finally {
        setIsSaving(false);
      }
    })();
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
        <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] uppercase text-ink-faint">
          {data.source === "default" ? "Default" : "Custom"}
        </span>
        <LimitValue label="Daily spend cap" value={formatCap(data.daily_spend_cap_micro_usd)} />
        <LimitValue label="Requests / min" value={formatCount(data.requests_per_minute)} />
        <LimitValue label="Tokens / min" value={formatCount(data.tokens_per_minute)} />
        {canManage && (
          <Button onClick={beginEdit} size="sm" type="button">
            Edit limits
          </Button>
        )}
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[140px] flex-1 flex-col gap-2 sm:max-w-[200px]">
          <span className="text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
            Daily spend cap ($)
          </span>
          <input
            className={LIMIT_INPUT}
            inputMode="decimal"
            min={0}
            onChange={(event) => setCapDollars(event.target.value)}
            placeholder="Uncapped"
            step="0.01"
            type="number"
            value={capDollars}
          />
        </label>
        <label className="flex min-w-[140px] flex-1 flex-col gap-2 sm:max-w-[200px]">
          <span className="text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
            Requests / min
          </span>
          <input
            className={LIMIT_INPUT}
            inputMode="numeric"
            min={1}
            onChange={(event) => setRequestsPerMinute(event.target.value)}
            placeholder="Uncapped"
            step={1}
            type="number"
            value={requestsPerMinute}
          />
        </label>
        <label className="flex min-w-[140px] flex-1 flex-col gap-2 sm:max-w-[200px]">
          <span className="text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
            Tokens / min
          </span>
          <input
            className={LIMIT_INPUT}
            inputMode="numeric"
            min={1}
            onChange={(event) => setTokensPerMinute(event.target.value)}
            placeholder="Uncapped"
            step={1}
            type="number"
            value={tokensPerMinute}
          />
        </label>
        <div className="flex gap-2">
          <Button disabled={isSaving} size="sm" type="submit" variant="primary">
            {isSaving ? "Saving…" : "Save limits"}
          </Button>
          <Button onClick={() => setEditing(false)} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
        </div>
      </div>
      <p className="m-0 text-[12px] text-muted">
        Saving replaces all three limits for this key; a blank field means uncapped.
      </p>
      {saveError !== null && <p className="m-0 text-[13px] text-danger">{saveError}</p>}
    </form>
  );
}

function LimitValue({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
        {label}
      </span>
      <span className="text-ink">{value}</span>
    </span>
  );
}

function formatCap(microUsd: number | null): string {
  if (microUsd === null) {
    return "Uncapped";
  }
  return `$${(microUsd / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatCount(value: number | null): string {
  return value === null ? "Uncapped" : value.toLocaleString();
}

// Blank means uncapped (null); the wire value is integer micro-USD.
function parseDollarsToMicroUsd(value: string): number | null | "invalid" {
  if (value.trim() === "") {
    return null;
  }
  const dollars = Number(value);
  if (!Number.isFinite(dollars) || dollars < 0) {
    return "invalid";
  }
  return Math.round(dollars * 1_000_000);
}

// Blank means uncapped (null); a set rate must be a whole count above zero.
function parsePerMinute(value: string): number | null | "invalid" {
  if (value.trim() === "") {
    return null;
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count <= 0) {
    return "invalid";
  }
  return count;
}
