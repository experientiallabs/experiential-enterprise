"use client";

import { useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { Check, Copy } from "lucide-react";

import { PlaygroundLink } from "@/components/playground/PlaygroundLink";
import { buttonClassName } from "@/components/ui/Button";
import { Snippet, chatCompletionsSnippets } from "@/components/world-models/endpoint-snippets";
import { apiKeysPath, docsPath } from "@/lib/routes";

const SNIPPET_TABS = [
  { key: "http", label: "HTTP" },
  { key: "curl", label: "cURL" },
  { key: "python", label: "Python" }
] as const;

type SnippetTab = (typeof SNIPPET_TABS)[number]["key"];

type ModelApiCardProps = {
  modelName: string;
  servingBaseUrl: string;
  /** Org UUID for the mint request body (/api/keys resolves orgs by id). */
  orgId: string;
  /** Whether the viewer may mint org API keys (org admin or platform operator). */
  canManageKeys: boolean;
};

/**
 * How to call this model: the endpoint URL leads (copyable), and the snippet
 * examples sit behind an HTTP / cURL / Python selector that starts collapsed;
 * picking one shows that snippet with its own copy control, picking it again
 * collapses it. The playground entry sits on the card's title row, far right.
 * A key minted here is an ordinary org key, so it appears in Settings -> API
 * keys alongside the rest; the plaintext secret is shown once.
 */
export function ModelApiCard({
  modelName,
  servingBaseUrl,
  orgId,
  canManageKeys
}: ModelApiCardProps) {
  const [tab, setTab] = useState<SnippetTab | null>(null);
  const snippets = chatCompletionsSnippets(modelName, servingBaseUrl);
  const endpointUrl = `${servingBaseUrl}/v1/chat/completions`;
  return (
    <section className="rounded-lg border border-line bg-surface p-[18px]" data-testid="api-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-[16px] font-semibold text-ink">API</h2>
        <PlaygroundLink modelName={modelName} />
      </div>

      <div className="flex flex-col gap-3">
        <div
          className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-background px-3 py-2"
          data-testid="api-endpoint-url"
        >
          <code className="overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-ink">
            <span className="mr-2 select-none font-semibold text-muted-2">POST</span>
            {endpointUrl}
          </code>
          <CopyButton label="Copy endpoint URL" text={endpointUrl} />
        </div>

        {/* The model-specific half of the call, OpenAI-style: the endpoint
            URL is shared, this request parameter names the model. */}
        <div
          className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-background px-3 py-2"
          data-testid="api-model-param"
        >
          <code className="overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-ink">
            <span className="mr-2 select-none font-semibold text-muted-2">model</span>
            {modelName}
          </code>
          <CopyButton label="Copy model name" text={modelName} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex w-fit rounded-md border border-line p-0.5 text-[12px]">
            {SNIPPET_TABS.map((entry) => (
              <button
                aria-pressed={tab === entry.key}
                className={clsx(
                  "cursor-pointer rounded px-3 py-1 transition-colors",
                  tab === entry.key ? "bg-ink text-white" : "text-ink-soft hover:text-ink"
                )}
                key={entry.key}
                // Toggle semantics: picking the open example again closes it,
                // so the card's rest state stays one quiet URL row.
                onClick={() => setTab((current) => (current === entry.key ? null : entry.key))}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
          <Link
            className="text-[12px] text-muted underline underline-offset-2 transition-colors hover:text-foreground"
            href={docsPath()}
          >
            API docs
          </Link>
        </div>

        {tab !== null ? (
          <div className="relative" data-testid="api-snippet">
            <Snippet text={snippets[tab]} />
            <div className="absolute right-2 top-2">
              <CopyButton label={`Copy ${tab} snippet`} text={snippets[tab]} />
            </div>
          </div>
        ) : null}

        <ApiKeyLine canManageKeys={canManageKeys} modelName={modelName} orgId={orgId} />
      </div>
    </section>
  );
}

/** One small clipboard control; flips to a check for a beat after copying. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      aria-label={label}
      className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-[var(--radius-md)] border border-line bg-surface text-foreground/60 transition-colors hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      type="button"
    >
      {copied ? <Check aria-hidden size={13} /> : <Copy aria-hidden size={13} />}
    </button>
  );
}

/**
 * The key the snippets authenticate with, as one quiet row: the sentence and
 * the mint button share a line, and the minted secret replaces them once with
 * a copy control and a pointer to where the key now lives. Non-admins get the
 * pointer to Settings instead of a dead button.
 */
function ApiKeyLine({
  canManageKeys,
  modelName,
  orgId
}: {
  canManageKeys: boolean;
  modelName: string;
  orgId: string;
}) {
  const [minting, setMinting] = useState(false);
  const [mintedSecret, setMintedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);

  async function mintKey() {
    setMintError(null);
    setMinting(true);
    try {
      const response = await fetch("/api/keys", {
        // The mint contract caps names at 80 chars; the model name is the
        // customer's own word for what this key is for.
        body: JSON.stringify({ orgId, name: `${modelName} key`.slice(0, 80) }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      const payload = (await response.json().catch(() => null)) as
        | { secret?: unknown; error?: unknown }
        | null;
      if (!response.ok || typeof payload?.secret !== "string") {
        setMintError(
          typeof payload?.error === "string" ? payload.error : "Unable to create the key."
        );
        return;
      }
      setMintedSecret(payload.secret);
      setCopied(false);
    } finally {
      setMinting(false);
    }
  }

  async function copySecret() {
    if (mintedSecret === null) {
      return;
    }
    await navigator.clipboard.writeText(mintedSecret);
    setCopied(true);
  }

  if (mintedSecret !== null) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-line-strong bg-background px-3 py-2.5"
        data-testid="api-key-minted"
      >
        <div className="min-w-0">
          <p className="m-0 mb-1 text-[12px] text-muted">
            Copy your key now; it is shown only once. It is saved with your{" "}
            <Link className="text-ink underline underline-offset-2" href={apiKeysPath()}>
              API keys
            </Link>{" "}
            in Settings.
          </p>
          <code className="block overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-ink">
            {mintedSecret}
          </code>
        </div>
        <button
          aria-label="Copy API key"
          className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-[var(--radius-md)] border border-line bg-surface text-foreground/60 hover:text-foreground"
          onClick={() => void copySecret()}
          type="button"
        >
          {copied ? <Check aria-hidden size={14} /> : <Copy aria-hidden size={14} />}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
      <p className="m-0 text-[13px] text-muted">
        Authenticate with an{" "}
        <Link className="text-ink underline underline-offset-2" href={apiKeysPath()}>
          org API key
        </Link>
        {canManageKeys ? "." : "; an organization admin can create one."}
      </p>
      {canManageKeys ? (
        <span className="flex items-center gap-3">
          {mintError !== null && (
            <span className="text-[12px] text-danger" data-testid="api-key-mint-error">
              {mintError}
            </span>
          )}
          <button
            className={buttonClassName(undefined, undefined, "sm")}
            disabled={minting}
            onClick={() => void mintKey()}
            type="button"
          >
            {minting ? "Creating…" : "Create API key"}
          </button>
        </span>
      ) : null}
    </div>
  );
}
