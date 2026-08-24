"use client";

// KeyHub's provider keys section: one table row per provider account — the
// mark and name, how it is hooked up, the masked key, the verified status
// badge, and the honest spend/credits figure — expanding to the verbose
// detail: the stored verdict in the provider's own words, the latest account
// snapshot, the admin-key slot (Anthropic/OpenAI), the self-reported balance
// gauge, rotate, and disconnect. Providers not yet connected render as quiet
// "hook up" rows in the same table. Signed out, the table still renders in
// full structure and every action routes to the login prompt; no
// account-scoped fetch fires.

import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown } from "lucide-react";
import { clsx } from "clsx";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { ProviderConnectForm, KEY_INPUT_CLASS } from "@/components/keys/provider-connect-form";
import {
  PROVIDER_ICONS,
  canReportSpend,
  hasSpendKey,
  hookupLine,
  hookupNeeds,
  spendKeyProblem,
  spendSummary,
  storedStatusMessage
} from "@/components/keys/provider-meta";
import {
  declareProviderBalance,
  disconnectProvider,
  refreshProviderSpend,
  useProviderConnections
} from "@/components/keys/store";
import { AdminOnlyNote } from "@/components/settings/IntegrationsPanel";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LocalDateTime } from "@/components/ui/LocalDateTime";
import { Shimmer } from "@/components/ui/Shimmer";
import { providerConnectionStatusLabel, providerConnectionStatusTone } from "@/lib/format";
import { MODEL_PROVIDERS, modelProviderLabel, type ModelProvider } from "@/lib/model-providers";
import type { ProviderConnectionSummary } from "@/lib/provider-connections";

export type ProviderKeysSectionProps = {
  /** UUID of the org whose connections are shown; null renders the signed-out state (no fetches fire). */
  orgId: string | null;
  canManage: boolean;
};

// Re-read a provider's spend/credits on mount when the shown reading is older
// than this. The backend enforces its own per-provider staleness floors, so
// this client-side window only avoids pointless round-trips.
const SPEND_REFRESH_STALE_MS = 15 * 60 * 1000;

const HEADER_CELL = "px-[18px] py-3 font-medium";
const BODY_CELL = "px-[18px] py-3";

/**
 * The signed-out structure: a provider as an unconnected row, the same shape
 * keys-P5 lists. Shared with the model page's UseViaKeyCard, whose signed-out
 * mount renders the same rows without any account-scoped fetch.
 */
export function disconnectedSummary(provider: ModelProvider): ProviderConnectionSummary {
  return {
    provider,
    connected: false,
    config: null,
    credential_last4: null,
    spend_credential_last4: null,
    updated_at: null,
    status: "unchecked",
    status_detail: null,
    status_checked_at: null,
    status_source: null,
    declared_balance_usd: null,
    declared_balance_set_at: null,
    metered_spend_usd: 0,
    low_balance_threshold_usd: 5,
    latest_snapshot: null
  };
}

export function ProviderKeysSection({ orgId, canManage }: ProviderKeysSectionProps) {
  const { open, requireAuth } = useLoginModal();
  const connectionsRead = useProviderConnections(orgId);
  const [openProvider, setOpenProvider] = useState<ModelProvider | null>(null);

  // Every mutation goes through this gate: signed out it prompts login in
  // place of acting; signed in it runs under requireAuth so an expired
  // session also lands in the modal once shell-P4 replaces the shim.
  const gate = (fn: () => void) => {
    if (orgId === null) {
      open();
      return;
    }
    requireAuth(fn);
  };

  // OpenRouter is the one provider whose plain key reads real credits, so
  // visiting a mount refreshes its reading when it is missing or stale. One
  // shot per mount; the backend's staleness floor absorbs anything faster.
  const autoRefreshed = useRef(false);
  useEffect(() => {
    if (autoRefreshed.current || orgId === null || !canManage || connectionsRead.data === null) {
      return;
    }
    autoRefreshed.current = true;
    const openrouter = connectionsRead.data.find((c) => c.provider === "openrouter");
    if (openrouter === undefined || !openrouter.connected) {
      return;
    }
    const takenAt = openrouter.latest_snapshot
      ? Date.parse(openrouter.latest_snapshot.taken_at)
      : Number.NaN;
    if (Number.isFinite(takenAt) && Date.now() - takenAt < SPEND_REFRESH_STALE_MS) {
      return;
    }
    void refreshProviderSpend(orgId, "openrouter");
  }, [canManage, connectionsRead.data, orgId]);

  const rows: ProviderConnectionSummary[] | null =
    orgId === null ? MODEL_PROVIDERS.map(disconnectedSummary) : connectionsRead.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-sm font-semibold text-ink">Provider keys</h2>
        <p className="m-0 max-w-[780px] text-muted text-[13px] leading-relaxed">
          Bring your own account. Requests your endpoints route to a connected provider bill to
          your key, and the models on it become serveable even where the platform holds no
          credentials. Keys are stored in Vault and never shown again.
        </p>
      </div>
      <section className="overflow-x-auto rounded-lg border border-line bg-surface">
        {rows === null && connectionsRead.error !== null ? (
          <p className="m-0 p-[18px] text-[13px] text-danger">{connectionsRead.error}</p>
        ) : rows === null ? (
          <div className="flex flex-col gap-3 p-[18px]">
            <Shimmer className="h-4 w-full" />
            <Shimmer className="h-4 w-full" />
            <Shimmer className="h-4 w-2/3" />
          </div>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
                <th className={HEADER_CELL}>Provider</th>
                <th className={HEADER_CELL}>Hooked up</th>
                <th className={HEADER_CELL}>Key</th>
                <th className={HEADER_CELL}>Status</th>
                <th className={HEADER_CELL}>Spend / credits</th>
                <th className="px-[18px] py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((connection) => (
                <ProviderRow
                  canManage={canManage}
                  connection={connection}
                  gate={gate}
                  key={connection.provider}
                  onToggle={() =>
                    setOpenProvider((current) =>
                      current === connection.provider ? null : connection.provider
                    )
                  }
                  open={openProvider === connection.provider}
                  orgId={orgId}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

type ProviderRowProps = {
  orgId: string | null;
  connection: ProviderConnectionSummary;
  canManage: boolean;
  open: boolean;
  onToggle: () => void;
  gate: (fn: () => void) => void;
};

function ProviderRow({ orgId, connection, canManage, open, onToggle, gate }: ProviderRowProps) {
  const Icon = PROVIDER_ICONS[connection.provider];
  const label = modelProviderLabel(connection.provider);
  return (
    <Fragment>
      <tr className={clsx("border-t border-line", open && "bg-surface-subtle/60")}>
        <td className={BODY_CELL}>
          <button
            aria-expanded={open}
            className="flex cursor-pointer items-center gap-2.5 border-0 bg-transparent p-0 text-left text-[13px] font-medium text-ink"
            onClick={onToggle}
            type="button"
          >
            <span
              aria-hidden
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line bg-foreground/[0.03] text-foreground/60"
            >
              <Icon aria-hidden size={14} strokeWidth={1.8} />
            </span>
            {label}
          </button>
        </td>
        <td className={clsx(BODY_CELL, connection.connected ? "text-muted" : "text-muted-2")}>
          {hookupLine(connection)}
        </td>
        <td className={clsx(BODY_CELL, "font-mono text-muted")}>
          {connection.credential_last4 ? `····${connection.credential_last4}` : "—"}
        </td>
        <td className={BODY_CELL}>
          {connection.connected ? (
            <Chip
              label={providerConnectionStatusLabel(connection.status)}
              tone={providerConnectionStatusTone(connection.status)}
            />
          ) : (
            <span className="text-muted-2">—</span>
          )}
        </td>
        <td className={clsx(BODY_CELL, "text-muted")}>{spendSummary(connection)}</td>
        <td className={clsx(BODY_CELL, "text-right")}>
          <button
            aria-label={`${open ? "Collapse" : "Expand"} ${label} details`}
            className="cursor-pointer rounded-full border border-line bg-transparent px-3 py-1 text-[12px] text-foreground/60 hover:border-line-strong hover:text-foreground"
            onClick={onToggle}
            type="button"
          >
            {connection.connected ? (
              <ChevronDown
                aria-hidden
                className={clsx("transition-transform duration-200", open && "rotate-180")}
                size={13}
                strokeWidth={1.8}
              />
            ) : (
              "Hook up"
            )}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-line bg-surface-subtle/40">
          <td className="px-[18px] py-4" colSpan={6}>
            <ExpandedDetail canManage={canManage} connection={connection} gate={gate} orgId={orgId} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function ExpandedDetail({
  orgId,
  connection,
  canManage,
  gate
}: {
  orgId: string | null;
  connection: ProviderConnectionSummary;
  canManage: boolean;
  gate: (fn: () => void) => void;
}) {
  const label = modelProviderLabel(connection.provider);
  // The stored admin key's own problem (it never touches the row's status).
  const adminKeyProblem = hasSpendKey(connection)
    ? spendKeyProblem(connection.status_detail)
    : null;
  return (
    <div className="flex max-w-[780px] flex-col gap-3">
      {!connection.connected && (
        <p className="m-0 text-[12px] text-muted">{hookupNeeds(connection.provider)}</p>
      )}
      {connection.connected && connection.status !== "valid" && connection.status !== "unchecked" && (
        <p className="m-0 rounded-[var(--radius-md)] bg-danger/10 px-2.5 py-2 text-[12px] leading-relaxed text-danger">
          {storedStatusMessage(connection)}
        </p>
      )}
      {connection.connected && connection.status_checked_at !== null && (
        <p className="m-0 text-[12px] text-muted-2">
          Checked <LocalDateTime value={connection.status_checked_at} />
          {connection.status_source === "traffic" ? " · from live traffic" : " · at hookup"}
        </p>
      )}
      {canManage || orgId === null ? (
        // Signed out the form still renders (structure is public); submitting
        // routes through the gate to the login prompt.
        <ProviderConnectForm connection={connection} gate={gate} orgId={orgId} />
      ) : (
        <AdminOnlyNote connected={connection.connected} noun="key" />
      )}
      {connection.connected && (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <SnapshotDetail connection={connection} />
          {adminKeyProblem !== null && (
            <p className="m-0 rounded-[var(--radius-md)] bg-danger/10 px-2.5 py-2 text-[12px] leading-relaxed text-danger">
              Admin key ····{connection.spend_credential_last4}: {adminKeyProblem}
            </p>
          )}
          <BalanceGauge canManage={canManage} connection={connection} gate={gate} orgId={orgId} />
          {canManage && (
            <DisconnectControl connection={connection} gate={gate} label={label} orgId={orgId} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The latest account snapshot in words. Until keys-P2's spend adapters land,
 * every connection honestly reads "no snapshots yet"; a sparkline over the
 * snapshot history is keys-P8's Overview work.
 */
function SnapshotDetail({ connection }: { connection: ProviderConnectionSummary }) {
  const snapshot = connection.latest_snapshot;
  if (snapshot === null) {
    return (
      <p className="m-0 text-[12px] text-muted">
        No account snapshots from {modelProviderLabel(connection.provider)} yet —{" "}
        {spendSummary(connection)}.
      </p>
    );
  }
  const source =
    snapshot.source === "provider_api" ? "reported by the provider" : "read from our side";
  return (
    <p className="m-0 text-[12px] text-muted">
      Last account snapshot <LocalDateTime value={snapshot.taken_at} />: {spendSummary(connection)}{" "}
      <span className="text-muted-2">({source})</span>
    </p>
  );
}

/** The self-reported balance gauge: declared remaining credit, drawn down by metered spend. */
function BalanceGauge({
  orgId,
  connection,
  canManage,
  gate
}: {
  orgId: string | null;
  connection: ProviderConnectionSummary;
  canManage: boolean;
  gate: (fn: () => void) => void;
}) {
  const label = modelProviderLabel(connection.provider);
  const [balanceDraft, setBalanceDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The refresh's honest non-error verdicts ("doesn't report this", a served
  // staleness floor) — quiet notes, not alarms.
  const [spendNote, setSpendNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Remaining = what they told us minus what we metered since; we cannot read
  // the real balance from most providers, so this is a courtesy gauge and is
  // labeled self-reported everywhere it renders.
  const remainingBalance =
    connection.declared_balance_usd === null
      ? null
      : connection.declared_balance_usd - connection.metered_spend_usd;
  const balanceLow =
    remainingBalance !== null && remainingBalance <= connection.low_balance_threshold_usd;

  function declareBalance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    const amount = Number(balanceDraft);
    if (balanceDraft.trim() === "" || !Number.isFinite(amount) || amount < 0) {
      setError("Enter the non-negative dollar balance left on your provider account.");
      return;
    }
    gate(() => {
      void (async () => {
        if (orgId === null) {
          return;
        }
        setError(null);
        setBusy(true);
        try {
          const failure = await declareProviderBalance(orgId, connection.provider, amount);
          if (failure !== null) {
            setError(failure.error);
            return;
          }
          setBalanceDraft("");
        } finally {
          setBusy(false);
        }
      })();
    });
  }

  function refreshSpend() {
    gate(() => {
      void (async () => {
        if (orgId === null || busy) {
          return;
        }
        setError(null);
        setSpendNote(null);
        setBusy(true);
        try {
          const result = await refreshProviderSpend(orgId, connection.provider);
          if ("error" in result) {
            setError(result.error);
            return;
          }
          const refresh = result.refresh;
          if (refresh.kind !== "reported" || !refresh.refreshed) {
            // Honest states in the backend's words — not errors to alarm over.
            setSpendNote(refresh.message);
          }
        } finally {
          setBusy(false);
        }
      })();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {remainingBalance !== null ? (
        <p className={`m-0 text-[12px] ${balanceLow ? "text-danger" : "text-muted"}`}>
          {balanceLow ? "Low balance: " : "Self-reported balance: "}
          <span className="font-mono">
            {remainingBalance < 0 ? "-" : ""}${Math.abs(remainingBalance).toFixed(2)}
          </span>{" "}
          left of the ${connection.declared_balance_usd?.toFixed(2)} you declared
          {connection.metered_spend_usd > 0 && (
            <>
              {" — "}
              <span className="font-mono">${connection.metered_spend_usd.toFixed(2)}</span> used
              through this key
              {connection.declared_balance_set_at ? (
                <>
                  {" "}
                  since <LocalDateTime value={connection.declared_balance_set_at} />
                </>
              ) : (
                ""
              )}
            </>
          )}
          {balanceLow ? " — top up with your provider or update the figure." : "."}
        </p>
      ) : (
        <p className="m-0 text-[12px] text-muted">
          Tell us the credit left on your {label} account and we draw it down as your traffic uses
          this key, so you hear about it before the provider cuts you off. This figure stays
          labeled self-reported.
        </p>
      )}
      {canManage && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={declareBalance}>
          <input
            aria-label={`Remaining ${label} balance in USD`}
            className={`${KEY_INPUT_CLASS} max-w-[140px]`}
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
            <Button loading={busy} onClick={refreshSpend} size="sm" type="button" variant="ghost">
              Refresh spend
            </Button>
          )}
        </form>
      )}
      {spendNote && <p className="m-0 text-[12px] text-muted-2">{spendNote}</p>}
      {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
    </div>
  );
}

/** Disconnect behind the house ConfirmDialog — deleting the stored key is irreversible. */
function DisconnectControl({
  orgId,
  connection,
  label,
  gate
}: {
  orgId: string | null;
  connection: ProviderConnectionSummary;
  label: string;
  gate: (fn: () => void) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function disconnect() {
    gate(() => {
      void (async () => {
        if (orgId === null || busy) {
          return;
        }
        setError(null);
        setBusy(true);
        try {
          const failure = await disconnectProvider(orgId, connection.provider);
          if (failure !== null) {
            setError(failure.error);
            return;
          }
          setConfirming(false);
        } finally {
          setBusy(false);
        }
      })();
    });
  }

  return (
    <div>
      <Button onClick={() => setConfirming(true)} size="sm" type="button" variant="destructive">
        Disconnect
      </Button>
      <ConfirmDialog
        body={`The stored ${label} key is deleted from Vault and traffic stops routing to this account. Reconnecting needs the key again.`}
        busy={busy}
        busyLabel="Disconnecting…"
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        error={error}
        onCancel={() => setConfirming(false)}
        onConfirm={disconnect}
        open={confirming}
        title={`Disconnect ${label}?`}
        tone="danger"
      />
    </div>
  );
}
