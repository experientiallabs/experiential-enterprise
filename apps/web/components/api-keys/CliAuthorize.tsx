"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Copy, TerminalSquare } from "lucide-react";

import type { ApiKeyRow } from "@/lib/api-keys/types";
import { buildLoopbackCallbackUrl } from "@/lib/api-keys/cli-auth";
import { overviewPath } from "@/lib/routes";

// How long the one-time key stays on screen after a successful copy before
// the page moves on to the organization.
const REDIRECT_AFTER_COPY_MS = 1500;

export type AuthorizableOrg = {
  id: string;
  slug: string;
  name: string;
  canManage: boolean;
};

type CliAuthorizeProps = {
  orgs: AuthorizableOrg[];
  state: string;
  port: number | null;
  initialKeyName: string;
};

type MintResponse = {
  apiKey: ApiKeyRow;
  secret: string;
};

// Approval form for a `wmo login` request. With a loopback port the minted
// key is handed straight back to the waiting CLI; without one the key is
// shown once for copy/paste (the CLI's --no-browser fallback prompt).
export function CliAuthorize({ orgs, state, port, initialKeyName }: CliAuthorizeProps) {
  const router = useRouter();
  const manageable = orgs.filter((org) => org.canManage);
  const [orgId, setOrgId] = useState(manageable[0]?.id ?? "");
  const selectedOrgSlug = manageable.find((org) => org.id === orgId)?.slug ?? "";
  const [name, setName] = useState(initialKeyName);
  const [mintedSecret, setMintedSecret] = useState<string | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/keys", {
        body: JSON.stringify({ orgId, name }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      const payload = (await response.json().catch(() => null)) as
        | (Partial<MintResponse> & { error?: unknown })
        | null;
      if (!response.ok || !payload?.secret) {
        setError(typeof payload?.error === "string" ? payload.error : "Unable to create the key.");
        return;
      }
      if (port !== null) {
        setHandedOff(true);
        // Full-page navigation to the CLI's loopback listener; loopback HTTP
        // is exempt from mixed-content blocking.
        window.location.assign(buildLoopbackCallbackUrl(port, payload.secret, state));
        return;
      }
      setMintedSecret(payload.secret);
      setCopied(false);
    } finally {
      setIsSubmitting(false);
    }
  }

  // Land the user in the workspace of the org they authorized: write the
  // active-org cookie, then go to their signed-in home.
  async function goToOrg() {
    await fetch("/api/active-org", {
      body: JSON.stringify({ org: selectedOrgSlug }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    router.push(overviewPath());
  }

  async function copySecret() {
    if (mintedSecret === null) {
      return;
    }
    await navigator.clipboard.writeText(mintedSecret);
    setCopied(true);
    // The key is safely on the clipboard; land the user back in their org.
    window.setTimeout(() => void goToOrg(), REDIRECT_AFTER_COPY_MS);
  }

  function continueToOrg() {
    void goToOrg();
  }

  if (manageable.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-surface p-[18px] text-[13px] text-muted">
        Connecting the wmo CLI mints an organization API key, which only organization admins can
        do. Ask an admin to run the login, or to grant you the admin role.
      </div>
    );
  }

  if (handedOff) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-[18px] text-[13px]">
        <TerminalSquare aria-hidden size={16} strokeWidth={1.8} />
        Key created, handing it to the CLI. You can return to your terminal.
      </div>
    );
  }

  if (mintedSecret !== null) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-line-strong bg-surface p-[18px]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 mb-1 text-[13px] font-semibold text-ink">
              Paste this key into your terminal, it is shown only once.
            </p>
            <code className="block overflow-x-auto whitespace-nowrap font-mono text-[13px]">
              {mintedSecret}
            </code>
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
        <div className="flex items-center justify-between text-[12px] text-muted">
          {copied ? "Copied, taking you to your organization…" : "Copy it before leaving this page."}
          <button
            className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-1 text-[12px] text-foreground/60 hover:border-line-strong hover:text-foreground"
            onClick={continueToOrg}
            type="button"
          >
            Continue to organization <ArrowRight aria-hidden size={12} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-[18px]" onSubmit={approve}>
      <label className="flex flex-col gap-2">
        <span className="text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
          Organization
        </span>
        <select
          className="w-full max-w-[360px] rounded-[var(--radius-md)] border border-line bg-background px-3 py-2 text-[13px] focus:outline-none focus:border-line-strong"
          onChange={(event) => setOrgId(event.target.value)}
          value={orgId}
        >
          {manageable.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-2">
        <span className="text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
          Key name
        </span>
        <input
          className="w-full max-w-[360px] rounded-[var(--radius-md)] border border-line bg-background px-3 py-2 text-[13px] focus:outline-none focus:border-line-strong"
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
      </label>
      {error !== null && (
        <div className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      )}
      <div>
        <button
          className="rounded-full bg-foreground px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-foreground/85 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isSubmitting || orgId === ""}
          type="submit"
        >
          {isSubmitting ? "Authorizing…" : "Authorize wmo CLI"}
        </button>
      </div>
    </form>
  );
}
