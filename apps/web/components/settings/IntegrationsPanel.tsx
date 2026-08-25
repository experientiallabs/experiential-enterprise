"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Activity, BarChart3, Brain, ChevronRight, Check, Database, Flame, Link2, Workflow } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { ConnectModal } from "@/components/settings/ConnectModal";
import { buildTraceSourceTransferPrompt } from "@/components/settings/trace-source-transfer-prompt";
import { readApiError } from "@/components/world-models/wm-client";
import { connectionKindLabel } from "@/lib/trace-ingest";

const INPUT_CLASS =
  "min-h-[34px] w-full rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";

// One recognizable glyph per managed connection kind; an unknown kind (a new
// provider landing before this map learns it) falls back to Activity.
const KIND_ICONS: Record<string, typeof Activity> = {
  phoenix: Flame,
  langfuse: Activity,
  langsmith: Link2,
  braintrust: Brain,
  posthog: BarChart3,
  mastra: Workflow,
  postgres: Database
};

export type ConnectionState = {
  kind: string;
  connected: boolean;
  credentialLast4: string | null;
  host: string | null;
  updatedAt: string | null;
  broadcastEnabled: boolean;
  broadcastPrivacyMode: boolean;
  broadcastCaptureToken: string | null;
};

// Kinds the broadcast tick can deliver to (mirrors the PATCH route; mastra
// has no public write contract and postgres is a trace source).
const BROADCAST_KINDS = new Set(["braintrust", "langfuse", "langsmith", "phoenix", "posthog"]);

type IntegrationsPanelProps = {
  orgId: string;
  connections: ConnectionState[];
  canManage: boolean;
  /** Public web origin, threaded to each source's transfer prompt. */
  webBaseUrl: string;
};

/** The status line under an integration's name in its collapsed tile. */
export function connectionStatusLine(connection: {
  connected: boolean;
  credentialLast4: string | null;
  updatedAt: string | null;
}): string {
  if (!connection.connected) {
    return "Not connected";
  }
  const key = connection.credentialLast4 ? `Key ····${connection.credentialLast4}` : "Connected";
  const when = connection.updatedAt
    ? ` · updated ${new Date(connection.updatedAt).toLocaleDateString()}`
    : "";
  return `${key}${when}`;
}

/**
 * Stored trace connections: the credentials trace imports use to pull this
 * organization's data. One connection per kind, credential in Vault (the
 * ingest flow writes the same store when a source carries credentials).
 * Each tile opens the shared ConnectModal — the same connect experience the
 * model providers get, transfer prompt included — to connect, rotate, or
 * disconnect. Secrets never come back.
 */
export function IntegrationsPanel({
  orgId,
  connections,
  canManage,
  webBaseUrl
}: IntegrationsPanelProps) {
  const [openKind, setOpenKind] = useState<string | null>(null);
  const active = connections.find((connection) => connection.kind === openKind) ?? null;
  const ActiveIcon = active !== null ? (KIND_ICONS[active.kind] ?? Activity) : Activity;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-sm font-semibold text-[#171717]">Trace sources</h2>
        <p className="m-0 max-w-[780px] text-muted text-[13px] leading-relaxed">
          Connect the observability stack or database your traces live in; imports can then pull
          them directly instead of file uploads, and continual learning can re-pull later. Keys
          are stored in Vault and never shown again.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {connections.map((connection) => {
          const Icon = KIND_ICONS[connection.kind] ?? Activity;
          return (
            <TraceSourceTile
              connection={connection}
              icon={<Icon aria-hidden size={16} strokeWidth={1.8} />}
              key={connection.kind}
              onOpen={() => setOpenKind(connection.kind)}
            />
          );
        })}
      </div>
      {active !== null && (
        <ConnectModal
          connected={active.connected}
          icon={<ActiveIcon aria-hidden size={16} strokeWidth={1.8} />}
          onClose={() => setOpenKind(null)}
          prompt={canManage ? buildTraceSourceTransferPrompt(active.kind, webBaseUrl) : null}
          promptTestId={`trace-transfer-prompt-${active.kind}`}
          status={connectionStatusLine(active)}
          testId={`trace-connect-modal-${active.kind}`}
          title={connectionKindLabel(active.kind)}
        >
          <ConnectionBody canManage={canManage} connection={active} orgId={orgId} />
        </ConnectModal>
      )}
    </div>
  );
}

/**
 * One trace source in the list: its glyph, name, and a one-line status, as a
 * button that opens the shared connect modal — the same tile idiom the model
 * providers above it use, so the merged Connections page reads as one system.
 */
function TraceSourceTile({
  connection,
  icon,
  onOpen
}: {
  connection: ConnectionState;
  icon: ReactNode;
  onOpen: () => void;
}) {
  const label = connectionKindLabel(connection.kind);
  return (
    <button
      className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-line bg-surface p-3.5 text-left transition-colors hover:border-line-strong"
      data-connected={connection.connected}
      data-testid={`integration-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
      onClick={onOpen}
      type="button"
    >
      <span
        aria-hidden
        className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-line bg-foreground/[0.03] text-foreground/60"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">{label}</span>
        <span
          className={
            connection.connected
              ? "block truncate text-[12px] text-muted"
              : "block truncate text-[12px] text-muted-2"
          }
        >
          {connectionStatusLine(connection)}
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

/** The members-only note shown in place of a credential form. */
export function AdminOnlyNote({ connected, noun }: { connected: boolean; noun: string }): ReactNode {
  return (
    <p className="m-0 text-[12px] text-muted">
      {connected
        ? `Connected. Only organization admins can change the ${noun}.`
        : "Only organization admins can connect."}
    </p>
  );
}

function ConnectionBody({
  orgId,
  connection,
  canManage
}: {
  orgId: string;
  connection: ConnectionState;
  canManage: boolean;
}) {
  const router = useRouter();
  const isDatabase = connection.kind === "postgres";
  const [secret, setSecret] = useState("");
  const [host, setHost] = useState(connection.host ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = connectionKindLabel(connection.kind);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (secret.trim().length === 0 || busy) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // A key rotation's broadcast settings are carried forward server-side
      // (the PUT route re-attaches stored config.broadcast before the
      // wholesale-replace upsert), so the client sends only what it edits.
      const config: Record<string, unknown> = {};
      if (!isDatabase && host.trim().length > 0) {
        config.host = host.trim();
      }
      const response = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/connections/${connection.kind}`,
        {
          body: JSON.stringify({ secret: secret.trim(), config }),
          headers: { "content-type": "application/json" },
          method: "PUT"
        }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to save the connection."));
        return;
      }
      setSecret("");
      router.refresh();
    } catch {
      setError("The connection could not be saved. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy || !window.confirm(`Disconnect ${label}? The stored credential is deleted.`)) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/connections/${connection.kind}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to disconnect."));
        return;
      }
      router.refresh();
    } catch {
      setError("The connection could not be removed. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    return <AdminOnlyNote connected={connection.connected} noun="credential" />;
  }

  return (
    <div className="flex flex-col gap-3">
      <form className="flex flex-col gap-2" onSubmit={save}>
      <input
        aria-label={isDatabase ? `${label} DSN` : `${label} API key`}
        autoComplete="off"
        className={INPUT_CLASS}
        onChange={(event) => setSecret(event.target.value)}
        placeholder={
          connection.connected
            ? isDatabase
              ? "Replace DSN"
              : "Replace API key"
            : isDatabase
              ? "postgresql://user:pass@host:5432/db"
              : "API key"
        }
        type="password"
        value={secret}
      />
      {!isDatabase && (
        <input
          aria-label={`${label} host (optional)`}
          className={INPUT_CLASS}
          onChange={(event) => setHost(event.target.value)}
          placeholder="Host (optional, for self-hosted)"
          type="url"
          value={host}
        />
      )}
        <div className="flex items-center gap-2">
          <Button disabled={secret.trim().length === 0} loading={busy} size="sm" type="submit">
            {connection.connected ? "Rotate" : "Connect"}
          </Button>
          {connection.connected && (
            <Button onClick={() => void disconnect()} size="sm" type="button" variant="ghost">
              Disconnect
            </Button>
          )}
        </div>
      </form>
      {connection.connected && BROADCAST_KINDS.has(connection.kind) && (
        <BroadcastControls busy={busy} connection={connection} onError={setError} orgId={orgId} setBusy={setBusy} />
      )}
      {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
    </div>
  );
}

/**
 * Per-destination Broadcast settings: an explicit opt-in to send this org's
 * opt-in captured prompts to the connected destination, with a privacy mode
 * that ships metadata only. Connecting a destination never broadcasts by
 * itself; these controls do.
 */
function BroadcastControls({
  orgId,
  connection,
  busy,
  setBusy,
  onError
}: {
  orgId: string;
  connection: ConnectionState;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const router = useRouter();
  const isPostHog = connection.kind === "posthog";
  // PostHog's capture ingest uses the project's PUBLIC write-only token, a
  // different key than the stored (private) credential; it round-trips
  // through config because PostHog itself embeds it in web pages.
  const [captureToken, setCaptureToken] = useState(connection.broadcastCaptureToken ?? "");

  async function patch(enabled: boolean, privacyMode: boolean) {
    if (busy) {
      return;
    }
    onError(null);
    setBusy(true);
    try {
      const broadcast: Record<string, unknown> = { enabled, privacy_mode: privacyMode };
      if (isPostHog && captureToken.trim().length > 0) {
        broadcast.capture_token = captureToken.trim();
      }
      const response = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/connections/${connection.kind}`,
        {
          body: JSON.stringify({ broadcast }),
          headers: { "content-type": "application/json" },
          method: "PATCH"
        }
      );
      if (!response.ok) {
        onError(await readApiError(response, "Unable to update broadcast settings."));
        return;
      }
      router.refresh();
    } catch {
      onError("Broadcast settings could not be saved. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
      <p className="m-0 text-[12px] font-medium text-ink">Broadcast</p>
      {isPostHog && (
        <input
          aria-label="PostHog project API key for broadcast"
          className={INPUT_CLASS}
          onChange={(event) => setCaptureToken(event.target.value)}
          placeholder="Project API key (phc_…), capture is write-only"
          type="text"
          value={captureToken}
        />
      )}
      <label className="flex items-center gap-2 text-[12px] text-muted">
        <input
          checked={connection.broadcastEnabled}
          disabled={busy}
          onChange={(event) => void patch(event.target.checked, connection.broadcastPrivacyMode)}
          type="checkbox"
        />
        Send captured prompts here (requires prompt capture below)
      </label>
      <label className="flex items-center gap-2 text-[12px] text-muted">
        <input
          checked={connection.broadcastPrivacyMode}
          disabled={busy || !connection.broadcastEnabled}
          onChange={(event) => void patch(connection.broadcastEnabled, event.target.checked)}
          type="checkbox"
        />
        Privacy mode: metadata only, no prompt content
      </label>
    </div>
  );
}
