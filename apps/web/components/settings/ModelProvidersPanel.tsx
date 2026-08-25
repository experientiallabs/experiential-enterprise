"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { AdminOnlyNote, connectionStatusLine } from "@/components/settings/IntegrationsPanel";
import { ProviderConnectModal } from "@/components/settings/ProviderConnectModal";
import { ProviderLogo } from "@/components/models-catalog/model-icon";
import { readApiError } from "@/components/world-models/wm-client";
import {
  providerBalanceLow,
  providerRemainingBalance
} from "@/lib/billing/provider-balances";
import {
  checkRemediation,
  isSpendKeyProvider,
  modelProviderLabel,
  type ModelProvider,
  type ProviderAccountSnapshot,
  type ProviderConnectionCheck,
  type ProviderConnectionStatus,
  type ProviderSpendRefresh
} from "@/lib/model-providers";

// The canonical states in customer words. Every non-valid state names the
// cause plainly; the stored remediation names the fix inside the tile.
const STATUS_LABELS: Record<ProviderConnectionStatus, string> = {
  unchecked: "not verified yet",
  valid: "verified",
  invalid: "invalid key",
  rate_limited: "rate limited",
  quota_exhausted: "out of quota",
  provider_error: "unverified, provider error"
};

// Re-read a provider's spend/credits on mount when the shown reading is older
// than this. The backend enforces its own per-provider staleness floors, so
// this client-side window only avoids pointless round-trips.
const SPEND_REFRESH_STALE_MS = 15 * 60 * 1000;

const INPUT_CLASS =
  "min-h-[34px] w-full rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";

export type ProviderConnectionState = {
  provider: ModelProvider;
  connected: boolean;
  credentialLast4: string | null;
  /** Non-secret config on the row; Azure's endpoint and deployment names. */
  config: Record<string, unknown> | null;
  updatedAt: string | null;
  /** Provider-verified key state: checked at hookup, updated by traffic. */
  status: ProviderConnectionStatus;
  /** Verbose provider error capture (raw code/message, remediation text). */
  statusDetail: Record<string, unknown> | null;
  statusCheckedAt: string | null;
  /** Last4 of the optional admin key (Anthropic/OpenAI spend reporting). */
  spendCredentialLast4: string | null;
  /** Self-reported remaining credit on their provider account; null = not tracked. */
  declaredBalanceUsd: number | null;
  declaredBalanceSetAt: string | null;
  /** Estimated spend metered through this key since the balance was declared. */
  meteredSpendUsd: number;
  lowBalanceThresholdUsd: number;
  /** The newest provider/our-side reading from provider_account_snapshots. */
  latestSnapshot: ProviderAccountSnapshot | null;
};

/** Whether this connection can produce a real provider/our-side spend reading. */
function canReportSpend(connection: ProviderConnectionState): boolean {
  switch (connection.provider) {
    case "openrouter":
    case "bedrock":
    case "fireworks":
    case "modal":
      return true;
    case "anthropic":
    case "openai":
      return connection.spendCredentialLast4 !== null;
    default:
      // Gemini and Azure honestly report nothing (AI Studio keys expose no
      // billing; Azure data-plane keys read nothing from Cost Management).
      return false;
  }
}

/** The latest real reading as one plain sentence: numbers, source, and when. */
function providerSpendLine(snapshot: ProviderAccountSnapshot): string {
  const parts: string[] = [];
  if (snapshot.spend_usd !== null) {
    parts.push(`$${snapshot.spend_usd.toFixed(2)} this month`);
  }
  if (snapshot.credits_remaining_usd !== null) {
    parts.push(`credits: $${snapshot.credits_remaining_usd.toFixed(2)} left`);
  }
  if (snapshot.usage_limit_usd !== null) {
    parts.push(`limit $${snapshot.usage_limit_usd.toFixed(2)}`);
  }
  const source = snapshot.source === "our_side" ? "from AWS Cost Explorer" : "provider-reported";
  const asOf = new Date(snapshot.taken_at).toLocaleString();
  return `${parts.length > 0 ? parts.join(" · ") : "No dollars reported"}, ${source}, ${asOf}.`;
}

/** The honest per-provider sentence shown where no real reading can exist. */
function spendEmptyState(connection: ProviderConnectionState): string {
  switch (connection.provider) {
    case "gemini":
      return "Google doesn't expose billing for AI Studio keys.";
    case "azure_openai":
      return "Azure doesn't report spend to a data-plane API key.";
    case "anthropic":
      return "Add an admin key (sk-ant-admin…) to see month-to-date spend.";
    case "openai":
      return "Add an admin key (sk-admin-…) to see month-to-date spend.";
    default:
      return "No spend reading yet, refresh to ask the provider.";
  }
}

type ModelProvidersPanelProps = {
  orgId: string;
  connections: ProviderConnectionState[];
  canManage: boolean;
  /** Public web origin, threaded to each connect modal's transfer prompt. */
  webBaseUrl: string;
  /** Public API base URL, threaded to each connect modal's transfer prompt. */
  apiBaseUrl: string;
};

/** One Azure deployment row while it is being edited, keyed for stable inputs. */
type DeploymentRow = { key: string; modelType: string; deployment: string };

/**
 * The org's own model-provider accounts. Connecting one moves that provider's
 * candidates onto the org's key: its models bill to this account instead of
 * platform credentials, and models the platform has no credentials for become
 * serveable at all. Keys are stored in Vault and never shown again.
 */
export function ModelProvidersPanel({
  orgId,
  connections,
  canManage,
  webBaseUrl,
  apiBaseUrl
}: ModelProvidersPanelProps) {
  const [openProvider, setOpenProvider] = useState<ModelProvider | null>(null);
  const active = connections.find((connection) => connection.provider === openProvider) ?? null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-sm font-semibold text-ink">Model providers</h2>
        <p className="m-0 max-w-[780px] text-muted text-[13px] leading-relaxed">
          Bring your own account. Requests your endpoints route to a connected provider bill to
          your key, and the models on it become serveable even where the platform holds no
          credentials. Keys are stored in Vault and never shown again.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {connections.map((connection) => (
          <ProviderTile
            connection={connection}
            key={connection.provider}
            onOpen={() => setOpenProvider(connection.provider)}
          />
        ))}
      </div>
      {active !== null && (
        <ProviderConnectModal
          apiBaseUrl={apiBaseUrl}
          canManage={canManage}
          connected={active.connected}
          onClose={() => setOpenProvider(null)}
          provider={active.provider}
          status={providerStatusLine(active)}
          webBaseUrl={webBaseUrl}
        >
          <ProviderBody canManage={canManage} connection={active} orgId={orgId} />
        </ProviderConnectModal>
      )}
    </div>
  );
}

/**
 * One provider in the list: its real brand logo, name, and a one-line status,
 * as a button that opens the connect/manage modal. Replaces the former inline
 * expander — connecting a provider is a focused task, so it earns a popup.
 */
function ProviderTile({
  connection,
  onOpen
}: {
  connection: ProviderConnectionState;
  onOpen: () => void;
}) {
  return (
    <button
      className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-line bg-surface p-3.5 text-left transition-colors hover:border-line-strong"
      data-connected={connection.connected}
      data-testid={`provider-tile-${connection.provider}`}
      onClick={onOpen}
      type="button"
    >
      <span
        aria-hidden
        className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-line bg-foreground/[0.03] text-foreground/70"
      >
        <ProviderLogo provider={connection.provider} size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">
          {modelProviderLabel(connection.provider)}
        </span>
        <span
          className={
            connection.connected
              ? "block truncate text-[12px] text-muted"
              : "block truncate text-[12px] text-muted-2"
          }
        >
          {providerStatusLine(connection)}
        </span>
      </span>
      {connection.connected && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
          <Check aria-hidden size={11} strokeWidth={2.2} /> Connected
        </span>
      )}
      <ChevronRight aria-hidden className="shrink-0 text-muted-2" size={15} strokeWidth={1.8} />
    </button>
  );
}

/**
 * The collapsed tile's status line: the key identity, its verified state, and
 * the drawdown gauge when one is tracked — a bad key or low balance is
 * visible without opening the tile. Exported for the /credits balance grid,
 * which opens the same connect modal and must describe the connection the
 * same way.
 */
export function providerStatusLine(connection: ProviderConnectionState): string {
  if (!connection.connected) {
    return connectionStatusLine(connection);
  }
  // Connected: show the key identity + its verified state, then the drawdown
  // gauge when a balance is tracked, so a bad key or low balance is visible
  // without opening the tile.
  const base = `${connectionStatusLine(connection)} · ${STATUS_LABELS[connection.status]}`;
  const remaining = providerRemainingBalance(connection);
  if (remaining !== null) {
    const sign = remaining < 0 ? "-" : "";
    return `${base} · ${sign}$${Math.abs(remaining).toFixed(2)} left`;
  }
  // No self-reported balance to draw down: fall back to a provider-reported
  // credits reading when one exists (OpenRouter), otherwise say so plainly.
  // The money page (and this panel) then shows every connected provider's
  // balance state at a glance, not only after the tile is expanded.
  const credits = connection.latestSnapshot?.credits_remaining_usd ?? null;
  if (credits !== null) {
    return `${base} · $${credits.toFixed(2)} credits`;
  }
  return `${base} · balance not tracked`;
}

/**
 * The per-provider connect/manage form inside the modal. Exported for the
 * /credits balance grid, which opens the SAME modal in place (the product owner,
 * credits/settings redesign 2026-08-22: connecting from the money page must
 * never navigate to settings). `offerStartingBalance` adds the credits page's
 * optional "starting balance" field to the connect form: a filled value is
 * declared (PATCH) right after a successful key save, so the new connection
 * starts with a tracked drawdown gauge.
 */
export function ProviderBody({
  orgId,
  connection,
  canManage,
  offerStartingBalance = false
}: {
  orgId: string;
  connection: ProviderConnectionState;
  canManage: boolean;
  offerStartingBalance?: boolean;
}) {
  const router = useRouter();
  const isAzure = connection.provider === "azure_openai";
  const isBedrock = connection.provider === "bedrock";
  const isFireworks = connection.provider === "fireworks";
  const isModal = connection.provider === "modal";
  const label = modelProviderLabel(connection.provider);
  const [secret, setSecret] = useState("");
  const [endpoint, setEndpoint] = useState(configString(connection.config, "endpoint"));
  const [apiVersion, setApiVersion] = useState(configString(connection.config, "api_version"));
  const [region, setRegion] = useState(configString(connection.config, "region"));
  const [accessKeyId, setAccessKeyId] = useState(configString(connection.config, "access_key_id"));
  const [accountId, setAccountId] = useState(configString(connection.config, "account_id"));
  // Modal's credential is a token PAIR; both halves ride one Vault secret.
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  // The optional admin key (Anthropic/OpenAI): spend reporting only.
  const [spendSecret, setSpendSecret] = useState("");
  const [spendNote, setSpendNote] = useState<string | null>(null);
  const [deployments, setDeployments] = useState<DeploymentRow[]>(() =>
    initialDeployments(connection.config)
  );
  const secretReady = isModal
    ? tokenId.trim().length > 0 && tokenSecret.trim().length > 0
    : secret.trim().length > 0;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [balanceDraft, setBalanceDraft] = useState("");
  // The credits page's optional starting balance, declared right after a
  // successful connect (empty = not tracked, same as connecting in settings).
  const [startingBalance, setStartingBalance] = useState("");
  // Remaining = what they told us minus what we metered since; we cannot read
  // the real balance from the provider, so this is a courtesy gauge.
  const remainingBalance = providerRemainingBalance(connection);
  const balanceLow = providerBalanceLow(connection);
  // OpenRouter is the one provider whose plain key reads real credits, so
  // opening this page refreshes its reading when it is missing or stale. One
  // shot per mount; the backend's staleness floor absorbs anything faster.
  const autoRefreshed = useRef(false);

  useEffect(() => {
    if (
      autoRefreshed.current ||
      connection.provider !== "openrouter" ||
      !connection.connected ||
      !canManage
    ) {
      return;
    }
    const takenAt = connection.latestSnapshot
      ? Date.parse(connection.latestSnapshot.taken_at)
      : Number.NaN;
    const fresh = Number.isFinite(takenAt) && Date.now() - takenAt < SPEND_REFRESH_STALE_MS;
    if (fresh) {
      return;
    }
    autoRefreshed.current = true;
    void refreshSpend();
    // refreshSpend is stable per render cycle; the ref guards re-entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, connection.connected, connection.latestSnapshot, connection.provider]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!secretReady || busy) {
      return;
    }
    // Validate the optional starting balance BEFORE the key saves, so a typo
    // never half-applies (key stored, balance silently dropped).
    const startingBalanceUsd = offerStartingBalance ? parseStartingBalance(startingBalance) : null;
    if (startingBalanceUsd instanceof Error) {
      setError(startingBalanceUsd.message);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/provider-connections/${connection.provider}`,
        {
          body: JSON.stringify({
            secret: isModal
              ? { token_id: tokenId.trim(), token_secret: tokenSecret.trim() }
              : secret.trim(),
            ...(spendSecret.trim().length > 0 ? { spendSecret: spendSecret.trim() } : {}),
            config: isAzure
              ? {
                  endpoint: endpoint.trim(),
                  ...(apiVersion.trim().length > 0 ? { api_version: apiVersion.trim() } : {}),
                  deployments: Object.fromEntries(
                    deployments
                      .filter(
                        (row) => row.modelType.trim().length > 0 && row.deployment.trim().length > 0
                      )
                      .map((row) => [row.modelType.trim(), row.deployment.trim()])
                  )
                }
              : isBedrock
                ? { region: region.trim(), access_key_id: accessKeyId.trim() }
                : isFireworks
                  ? { account_id: accountId.trim() }
                  : {}
          }),
          headers: { "content-type": "application/json" },
          method: "PUT"
        }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to save the provider key."));
        return;
      }
      // The save round-trip carries the hookup check's verdict; a non-valid
      // outcome renders here immediately, in the provider's own words.
      const payload = (await response.json().catch(() => null)) as {
        check?: ProviderConnectionCheck | null;
        spendError?: string | null;
      } | null;
      const check = payload?.check ?? null;
      // The provider key saved even when the optional admin/spend key did not;
      // report the spend failure without claiming the whole save failed.
      if (payload?.spendError != null && payload.spendError.length > 0) {
        setError(`The provider key was saved, but the admin key could not: ${payload.spendError}`);
      } else if (check !== null && check.status !== "valid") {
        setError(
          checkRemediation(check) ??
            `The key was saved but its check came back ${STATUS_LABELS[check.status]}.`
        );
      }
      // Declare the starting balance the customer typed (credits page only).
      // The key IS saved at this point, so a failed declare reports itself
      // without claiming the connect failed.
      if (startingBalanceUsd !== null) {
        const declareResponse = await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/provider-connections/${connection.provider}`,
          {
            body: JSON.stringify({ declared_balance_usd: startingBalanceUsd }),
            headers: { "content-type": "application/json" },
            method: "PATCH"
          }
        );
        if (!declareResponse.ok) {
          setError(
            await readApiError(
              declareResponse,
              "The key was saved, but the starting balance could not be."
            )
          );
        } else {
          setStartingBalance("");
        }
      }
      setSecret("");
      setTokenId("");
      setTokenSecret("");
      setSpendSecret("");
      router.refresh();
    } catch {
      // A network-level rejection (offline, server unreachable) must not
      // leave a silent idle form that looks like a successful save.
      setError("The key could not be saved. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshSpend() {
    if (busy) {
      return;
    }
    setError(null);
    setSpendNote(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/provider-connections/${connection.provider}/spend-refresh`,
        { method: "POST" }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to read spend from the provider."));
        return;
      }
      const refresh = (await response.json()) as ProviderSpendRefresh;
      if (refresh.kind === "read_failed" || refresh.kind === "not_reportable") {
        // Honest states, in the backend's words — not errors to alarm over.
        setSpendNote(refresh.message);
        return;
      }
      if (!refresh.refreshed) {
        setSpendNote(refresh.message);
      }
      router.refresh();
    } catch {
      setError("Spend could not be refreshed. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  async function declareBalance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    const amount = Number(balanceDraft);
    if (balanceDraft.trim() === "" || !Number.isFinite(amount) || amount < 0) {
      setError("Enter the non-negative dollar balance left on your provider account.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/provider-connections/${connection.provider}`,
        {
          body: JSON.stringify({ declared_balance_usd: amount }),
          headers: { "content-type": "application/json" },
          method: "PATCH"
        }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to save the balance."));
        return;
      }
      setBalanceDraft("");
      router.refresh();
    } catch {
      setError("The balance could not be saved. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy || !window.confirm(`Disconnect ${label}? The stored key is deleted.`)) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/provider-connections/${connection.provider}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to disconnect."));
        return;
      }
      router.refresh();
    } catch {
      setError("The provider could not be disconnected. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {canManage ? (
        <form className="flex flex-col gap-2" onSubmit={save}>
          {!isModal && (
            <input
              aria-label={isBedrock ? `${label} secret access key` : `${label} API key`}
              autoComplete="off"
              className={INPUT_CLASS}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={
                isBedrock
                  ? connection.connected
                    ? "Replace secret access key"
                    : "Secret access key"
                  : connection.connected
                    ? "Replace API key"
                    : "API key"
              }
              type="password"
              value={secret}
            />
          )}
          {isModal && (
            <>
              <input
                aria-label="Modal token id"
                autoComplete="off"
                className={INPUT_CLASS}
                onChange={(event) => setTokenId(event.target.value)}
                placeholder={connection.connected ? "Replace token id (ak-…)" : "Token id (ak-…)"}
                type="text"
                value={tokenId}
              />
              <input
                aria-label="Modal token secret"
                autoComplete="off"
                className={INPUT_CLASS}
                onChange={(event) => setTokenSecret(event.target.value)}
                placeholder={
                  connection.connected ? "Replace token secret (as-…)" : "Token secret (as-…)"
                }
                type="password"
                value={tokenSecret}
              />
            </>
          )}
          {isSpendKeyProvider(connection.provider) && (
            <input
              aria-label={`${label} admin key (optional)`}
              autoComplete="off"
              className={INPUT_CLASS}
              onChange={(event) => setSpendSecret(event.target.value)}
              placeholder={
                connection.spendCredentialLast4
                  ? `Admin key (optional), stored ····${connection.spendCredentialLast4}`
                  : "Admin key (optional), lets us show your month-to-date spend"
              }
              type="password"
              value={spendSecret}
            />
          )}
          {isFireworks && (
            <input
              aria-label="Fireworks account id"
              autoComplete="off"
              className={INPUT_CLASS}
              onChange={(event) => setAccountId(event.target.value)}
              placeholder="Account id (the account slug on fireworks.ai)"
              type="text"
              value={accountId}
            />
          )}
          {isBedrock && (
            <>
              <input
                aria-label="AWS access key id"
                autoComplete="off"
                className={INPUT_CLASS}
                onChange={(event) => setAccessKeyId(event.target.value)}
                placeholder="AWS access key id"
                type="text"
                value={accessKeyId}
              />
              <input
                aria-label="AWS region"
                autoComplete="off"
                className={INPUT_CLASS}
                onChange={(event) => setRegion(event.target.value)}
                placeholder="us-east-1"
                type="text"
                value={region}
              />
            </>
          )}
          {isAzure && (
            <>
              <input
                aria-label="Azure Foundry resource endpoint"
                className={INPUT_CLASS}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://my-resource.openai.azure.com"
                type="url"
                value={endpoint}
              />
              <input
                aria-label="Azure Foundry API version (optional)"
                className={INPUT_CLASS}
                onChange={(event) => setApiVersion(event.target.value)}
                placeholder="API version (optional)"
                type="text"
                value={apiVersion}
              />
              <DeploymentRows onChange={setDeployments} rows={deployments} />
            </>
          )}
          {offerStartingBalance && (
            <input
              aria-label={`Starting ${label} credits balance in USD (optional)`}
              autoComplete="off"
              className={INPUT_CLASS}
              min="0"
              onChange={(event) => setStartingBalance(event.target.value)}
              placeholder="Starting credits balance ($, optional)"
              step="0.01"
              type="number"
              value={startingBalance}
            />
          )}
          <div className="flex items-center gap-2">
            <Button disabled={!secretReady} loading={busy} size="sm" type="submit">
              {connection.connected ? "Rotate" : "Connect"}
            </Button>
            {connection.connected && (
              <Button onClick={() => void disconnect()} size="sm" type="button" variant="ghost">
                Disconnect
              </Button>
            )}
          </div>
          {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
        </form>
      ) : (
        <AdminOnlyNote connected={connection.connected} noun="key" />
      )}
      {connection.connected && connection.status !== "valid" && connection.status !== "unchecked" && (
        <p className="m-0 rounded-[var(--radius-md)] bg-danger/10 px-2.5 py-2 text-[12px] leading-relaxed text-danger">
          {storedStatusMessage(connection)}
        </p>
      )}
      {connection.connected && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          {connection.latestSnapshot && connection.latestSnapshot.source !== "self_reported" ? (
            <p className="m-0 text-[12px] text-muted">
              {providerSpendLine(connection.latestSnapshot)}
            </p>
          ) : (
            <p className="m-0 text-[12px] text-muted">{spendEmptyState(connection)}</p>
          )}
          {spendNote && <p className="m-0 text-[12px] text-muted-2">{spendNote}</p>}
          {remainingBalance !== null ? (
            <p className={`m-0 text-[12px] ${balanceLow ? "text-danger" : "text-muted"}`}>
              {balanceLow ? "Low balance (self-reported): " : "Self-reported balance: "}
              <span className="font-mono">
                {remainingBalance < 0 ? "-" : ""}${Math.abs(remainingBalance).toFixed(2)}
              </span>{" "}
              left of the ${connection.declaredBalanceUsd?.toFixed(2)} you declared
              {connection.meteredSpendUsd > 0 && (
                <>
                  {", "}
                  <span className="font-mono">${connection.meteredSpendUsd.toFixed(2)}</span> used
                  through this key
                  {connection.declaredBalanceSetAt
                    ? ` since ${new Date(connection.declaredBalanceSetAt).toLocaleDateString()}`
                    : ""}
                </>
              )}
              {balanceLow ? ", top up with your provider or update the figure." : "."}
            </p>
          ) : (
            <p className="m-0 text-[12px] text-muted">
              Tell us the credit left on your {label} account (self-reported) and we draw it
              down as your traffic uses this key, so you hear about it before the provider
              cuts you off.
            </p>
          )}
          {canManage && (
            <form className="flex flex-wrap items-center gap-2" onSubmit={declareBalance}>
              <input
                aria-label={`Remaining ${label} balance in USD (self-reported)`}
                className={`${INPUT_CLASS} max-w-[140px]`}
                min="0"
                onChange={(event) => setBalanceDraft(event.target.value)}
                placeholder="Balance left ($)"
                step="0.01"
                type="number"
                value={balanceDraft}
              />
              <Button disabled={balanceDraft.trim() === ""} loading={busy} size="sm" type="submit">
                {remainingBalance === null ? "Track balance" : "Update"}
              </Button>
              {canReportSpend(connection) && (
                <Button
                  loading={busy}
                  onClick={() => void refreshSpend()}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Refresh spend
                </Button>
              )}
            </form>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Azure addresses deployments rather than model ids, so a key alone cannot
 * route: each model the org wants served needs the deployment name it lives
 * under in that resource.
 */
function DeploymentRows({
  onChange,
  rows
}: {
  onChange: (rows: DeploymentRow[]) => void;
  rows: DeploymentRow[];
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-line px-3 py-2.5">
      <p className="m-0 text-[12px] leading-relaxed text-muted">
        Deployments: the name each model is served under in your resource.
      </p>
      {rows.map((row, index) => (
        <div className="flex items-center gap-2" key={row.key}>
          <input
            aria-label={`Model ${index + 1}`}
            className={INPUT_CLASS}
            onChange={(event) =>
              onChange(rows.map((r) => (r.key === row.key ? { ...r, modelType: event.target.value } : r)))
            }
            placeholder="gpt-5.5"
            type="text"
            value={row.modelType}
          />
          <span aria-hidden className="text-[12px] text-muted-2">
            to
          </span>
          <input
            aria-label={`Deployment ${index + 1}`}
            className={INPUT_CLASS}
            onChange={(event) =>
              onChange(
                rows.map((r) => (r.key === row.key ? { ...r, deployment: event.target.value } : r))
              )
            }
            placeholder="my-gpt-5-5-deployment"
            type="text"
            value={row.deployment}
          />
          <button
            aria-label={`Remove deployment ${index + 1}`}
            className="shrink-0 cursor-pointer rounded-md border border-line bg-surface p-1 text-muted transition-colors hover:text-foreground"
            onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
            type="button"
          >
            <X aria-hidden size={13} strokeWidth={1.8} />
          </button>
        </div>
      ))}
      <button
        className="inline-flex w-fit cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-[12.5px] text-muted transition-colors hover:text-foreground"
        onClick={() => onChange([...rows, emptyDeployment()])}
        type="button"
      >
        <Plus aria-hidden size={13} strokeWidth={1.8} />
        Add deployment
      </button>
    </div>
  );
}

/**
 * The optional starting-balance draft as dollars: null when left empty, an
 * Error naming the problem when filled with garbage or a negative figure.
 */
function parseStartingBalance(draft: string): number | null | Error {
  if (draft.trim() === "") {
    return null;
  }
  const amount = Number(draft);
  if (!Number.isFinite(amount) || amount < 0) {
    return new Error("Enter a non-negative dollar amount for the starting balance.");
  }
  return amount;
}

let deploymentKeySeed = 0;

function emptyDeployment(): DeploymentRow {
  deploymentKeySeed += 1;
  return { key: `deployment-${deploymentKeySeed}`, modelType: "", deployment: "" };
}

/** The stored deployment map as editable rows; one empty row when there is none. */
function initialDeployments(config: Record<string, unknown> | null): DeploymentRow[] {
  const stored = config?.deployments;
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
    const rows = Object.entries(stored as Record<string, unknown>)
      .filter(([, deployment]) => typeof deployment === "string")
      .map(([modelType, deployment]) => ({
        ...emptyDeployment(),
        modelType,
        deployment: deployment as string
      }));
    if (rows.length > 0) {
      return rows;
    }
  }
  return [emptyDeployment()];
}

function configString(config: Record<string, unknown> | null, key: string): string {
  const value = config?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * The stored verdict in full: our remediation text (self-sufficient by
 * contract), with the provider's raw words behind it when they add anything.
 */
function storedStatusMessage(connection: ProviderConnectionState): string {
  const detail = connection.statusDetail;
  const remediation = typeof detail?.remediation === "string" ? detail.remediation : null;
  const providerMessage =
    typeof detail?.provider_message === "string" ? detail.provider_message : null;
  if (remediation !== null) {
    return providerMessage !== null && !remediation.includes(providerMessage)
      ? `${remediation} (Provider said: "${providerMessage}")`
      : remediation;
  }
  if (providerMessage !== null) {
    return `${STATUS_LABELS[connection.status]}: ${providerMessage}`;
  }
  return STATUS_LABELS[connection.status];
}
