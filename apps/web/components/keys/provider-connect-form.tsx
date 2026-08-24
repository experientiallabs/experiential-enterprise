"use client";

// The connect/rotate credential form for one provider, shared by every KeyHub
// mount (settings row today, the model page's inline "add a new key" with
// keys-P7). Least clicks: paste then save; the hookup check runs inside the save
// round-trip, so the row lands already-verified and a non-valid verdict
// renders here immediately, in the provider's own words. Which fields render and
// which gate submit come from the per-provider schema in lib/provider-fields
// (Azure endpoint/deployments, Bedrock secret/key-id/region, Fireworks account
// id, Modal's token pair, everyone else a bare key), so the field set for a
// provider is defined once and both the UI and its validation read from it.

import { useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";

import { spendKeyProblem } from "@/components/keys/provider-meta";
import { connectProvider } from "@/components/keys/store";
import { Button } from "@/components/ui/Button";
import { providerConnectionStatusLabel } from "@/lib/format";
import { checkRemediation, modelProviderLabel } from "@/lib/model-providers";
import { isProviderFormReady, providerFieldSchema } from "@/lib/provider-fields";
import type { ProviderConnectionSummary } from "@/lib/provider-connections";

export const KEY_INPUT_CLASS =
  "min-h-[34px] w-full rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";

/** One Azure deployment row while it is being edited, keyed for stable inputs. */
type DeploymentRow = { key: string; modelType: string; deployment: string };

type ProviderConnectFormProps = {
  /** Null while signed out; `gate` then routes the submit to the login prompt. */
  orgId: string | null;
  connection: ProviderConnectionSummary;
  /** Wraps every mutation: login prompt when signed out, requireAuth otherwise. */
  gate: (fn: () => void) => void;
};

export function ProviderConnectForm({ orgId, connection, gate }: ProviderConnectFormProps) {
  // The provider's field set drives both what renders and what gates submit, so
  // each provider is called exactly as it needs (Azure endpoint + deployments,
  // Bedrock key-id + region, Modal token pair, everyone else a bare key).
  const schema = providerFieldSchema(connection.provider);
  const isPair = schema.secret.kind === "pair";
  const [secret, setSecret] = useState("");
  // Scalar config values keyed by field name, seeded from the stored config so a
  // rotate keeps the endpoint/region/account already on the connection.
  const [config, setConfig] = useState<Record<string, string>>(() =>
    Object.fromEntries(schema.config.map((field) => [field.name, configString(connection.config, field.name)]))
  );
  // Modal's credential is a token PAIR; both halves ride one Vault secret.
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  // The optional admin key (Anthropic/OpenAI): spend reporting only. It rides
  // the same PUT as the main key; the backend validates the prefix in both
  // directions and verifies both credentials in one hookup check.
  const [spendSecret, setSpendSecret] = useState("");
  const [deployments, setDeployments] = useState<DeploymentRow[]>(() =>
    schema.hasDeployments ? initialDeployments(connection.config) : []
  );
  const completeDeployments = deployments.filter(
    (row) => row.modelType.trim().length > 0 && row.deployment.trim().length > 0
  );
  const ready = isProviderFormReady(schema, {
    secret,
    tokenId,
    tokenSecret,
    config,
    hasDeployment: completeDeployments.length > 0
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) {
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
          // Required config fields are always sent (trimmed); optional ones only
          // when filled, matching each backend parser's contract.
          const configPayload: Record<string, unknown> = {};
          for (const field of schema.config) {
            const value = (config[field.name] ?? "").trim();
            if (field.required || value.length > 0) {
              configPayload[field.name] = value;
            }
          }
          if (schema.hasDeployments) {
            configPayload.deployments = Object.fromEntries(
              completeDeployments.map((row) => [row.modelType.trim(), row.deployment.trim()])
            );
          }
          const result = await connectProvider(orgId, connection.provider, {
            secret: isPair
              ? { token_id: tokenId.trim(), token_secret: tokenSecret.trim() }
              : secret.trim(),
            ...(spendSecret.trim().length > 0 ? { spendSecret: spendSecret.trim() } : {}),
            config: configPayload
          });
          if ("error" in result) {
            setError(result.error);
            return;
          }
          // The save round-trip carries the hookup check's verdict; a
          // non-valid outcome renders here immediately. The admin key gets
          // its own sub-verdict (it never affects the key-level status).
          const check = result.check;
          if (check !== null && check.status !== "valid") {
            setError(
              checkRemediation(check) ??
                `The key was saved but its check came back ${providerConnectionStatusLabel(check.status).toLowerCase()}.`
            );
          } else if (check !== null) {
            const adminProblem = spendKeyProblem(check.status_detail);
            if (adminProblem !== null) {
              setError(`The API key verified, but the admin key did not: ${adminProblem}`);
            }
          }
          setSecret("");
          setTokenId("");
          setTokenSecret("");
          setSpendSecret("");
        } finally {
          setBusy(false);
        }
      })();
    });
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={save}>
      {schema.secret.kind === "single" ? (
        <input
          aria-label={schema.secret.label}
          autoComplete="off"
          className={KEY_INPUT_CLASS}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={
            connection.connected ? schema.secret.rotatePlaceholder : schema.secret.placeholder
          }
          type="password"
          value={secret}
        />
      ) : (
        <>
          <input
            aria-label={schema.secret.id.label}
            autoComplete="off"
            className={KEY_INPUT_CLASS}
            onChange={(event) => setTokenId(event.target.value)}
            placeholder={
              connection.connected
                ? schema.secret.id.rotatePlaceholder
                : schema.secret.id.placeholder
            }
            type="text"
            value={tokenId}
          />
          <input
            aria-label={schema.secret.secret.label}
            autoComplete="off"
            className={KEY_INPUT_CLASS}
            onChange={(event) => setTokenSecret(event.target.value)}
            placeholder={
              connection.connected
                ? schema.secret.secret.rotatePlaceholder
                : schema.secret.secret.placeholder
            }
            type="password"
            value={tokenSecret}
          />
        </>
      )}
      {schema.hasSpendKey && (
        <input
          aria-label={`${modelProviderLabel(connection.provider)} admin key (optional)`}
          autoComplete="off"
          className={KEY_INPUT_CLASS}
          onChange={(event) => setSpendSecret(event.target.value)}
          placeholder={
            connection.spend_credential_last4
              ? `Admin key (optional), stored ····${connection.spend_credential_last4}`
              : "Admin key (optional), lets us show your month-to-date spend"
          }
          type="password"
          value={spendSecret}
        />
      )}
      {schema.config.map((field) => (
        <input
          aria-label={field.label}
          autoComplete="off"
          className={KEY_INPUT_CLASS}
          key={field.name}
          onChange={(event) =>
            setConfig((current) => ({ ...current, [field.name]: event.target.value }))
          }
          placeholder={field.placeholder}
          type={field.type}
          value={config[field.name] ?? ""}
        />
      ))}
      {schema.hasDeployments && <DeploymentRows onChange={setDeployments} rows={deployments} />}
      <div className="flex items-center gap-2">
        <Button disabled={!ready} loading={busy} size="sm" type="submit">
          {connection.connected ? "Rotate" : "Connect"}
        </Button>
      </div>
      {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
    </form>
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
            className={KEY_INPUT_CLASS}
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
            className={KEY_INPUT_CLASS}
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
