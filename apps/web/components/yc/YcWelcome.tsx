"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";

import { ConfettiBurst } from "@/components/auth/ConfettiBurst";
import { buttonClassName } from "@/components/ui/Button";
import { buildGatewaySetupPrompt } from "@/components/onboarding/setup-prompt";
import { clearYcIntent } from "@/components/yc/yc-intent";
import { LocalDateTime } from "@/components/ui/LocalDateTime";
import { formatKeyIdentity } from "@/lib/api-keys/format";
import { formatGrantUsd, formatSignedCostUsd } from "@/lib/money";
import { creditsPath, overviewPath } from "@/lib/routes";
import { captureTelemetryEvent } from "@/lib/telemetry/client";
import type { YcClaimState } from "@/lib/types";

/** the product owner's verbatim recovery path for a duplicate claim (plan §2). */
const RECOVERY_LINE = "DM me and claim your reward.";

/**
 * The scannable summary of what the pasted prompt does, so a founder sees the
 * agent's job at a glance before copying (round-3: "make it more obvious what
 * the agent is going to do"). Mirrors the numbered steps in setup-prompt.ts.
 */
const SETUP_STEPS: readonly string[] = [
  "Points an OpenAI-compatible client at the gateway with your key",
  "Runs one cheap test call on your free credits to prove it end to end",
  "Works even in a messy multi-project folder — never stops to ask",
  "Hands you the optional extras (connect your own keys, import history) to do here"
];

type GrantState =
  | { kind: "granted"; grantedUsd: number; expiresAt: string }
  | { kind: "active"; remainingUsd: number; expiresAt: string }
  | { kind: "conflict"; message: string }
  | { kind: "failed"; message: string };

type WelcomeRead = {
  orgId: string;
  keyPrefix: string | null;
  // Stored display tail of the existing key; null when the key predates the
  // key_suffix column (or when there is no key at all).
  keySuffix: string | null;
  canManageKeys: boolean;
};

type Phase =
  | { phase: "loading" }
  | { phase: "no_org"; message: string }
  | {
      phase: "ready";
      grant: GrantState;
      keySecret: string | null;
      keyPrefix: string | null;
      keySuffix: string | null;
    };

type YcWelcomeProps = {
  webBaseUrl: string;
  apiBaseUrl: string;
};

/**
 * The post-login half of the YC deal on /signin?yc=1: the login itself is the
 * claim. On mount this auto-claims the $526 grant (idempotent — a duplicate
 * shows the grant's state), surfaces the org API key exactly like the login
 * modal's success step (minted fresh for a keyless org, prefix-only
 * otherwise), and renders the agent setup prompt with the real key embedded.
 * Light by default on the design-system tokens (round-3: the post-login
 * surface reads light, not the dark co-branded pitch), with the paste-the-
 * prompt CTA as the top, most prominent action.
 */
export function YcWelcome({ webBaseUrl, apiBaseUrl }: YcWelcomeProps) {
  const [state, setState] = useState<Phase>({ phase: "loading" });

  useEffect(() => {
    // The intent marker got the user here; clearing it stops the Overview
    // guard and the sign-in fallback from re-routing an already-served user.
    clearYcIntent();
    let cancelled = false;
    void (async () => {
      const welcome = await readYcWelcome();
      if (welcome === null) {
        if (!cancelled) {
          setState({
            phase: "no_org",
            message: "We couldn't load your workspace. Refresh to retry."
          });
        }
        return;
      }
      // The grant and the key are independent: a claim hiccup must not hide
      // the key or the prompt (and vice versa).
      const grant = await claimGrant(welcome.orgId);
      let keySecret: string | null = null;
      if (welcome.keyPrefix === null && welcome.canManageKeys) {
        keySecret = await mintDefaultKey(welcome.orgId);
      }
      if (!cancelled) {
        setState({
          phase: "ready",
          grant,
          keySecret,
          keyPrefix: welcome.keyPrefix,
          keySuffix: welcome.keySuffix
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === "loading") {
    return (
      <div className="flex flex-col gap-3" data-testid="yc-welcome-loading">
        <div className="h-5 w-2/3 animate-pulse rounded-[var(--radius-sm)] bg-surface-subtle" />
        <div className="h-24 w-full animate-pulse rounded-[var(--radius-md)] bg-surface-subtle" />
        <div className="h-64 w-full animate-pulse rounded-[var(--radius-md)] bg-surface-subtle" />
      </div>
    );
  }
  if (state.phase === "no_org") {
    return (
      <p className="m-0 text-sm text-muted" role="alert">
        {state.message}
      </p>
    );
  }

  const prompt = buildGatewaySetupPrompt(webBaseUrl, apiBaseUrl, state.keySecret);
  return (
    <div className="flex flex-col gap-3" data-testid="yc-welcome">
      {/* The point of the page: the paste CTA is the top, most prominent action. */}
      <section className="overflow-hidden rounded-[var(--radius-lg)] border border-line-strong bg-surface">
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="m-0 text-[19px] font-semibold leading-tight tracking-tight text-ink">
              Paste this into your coding agent
            </h2>
            <p className="m-0 mt-1 text-[13px] leading-snug text-muted">
              It does the rest. No setup on your side.
            </p>
          </div>
          <CopyButton label="Copy setup prompt" prominent text={prompt} />
        </div>

        <ol className="m-0 flex flex-col gap-1.5 border-b border-line px-4 py-3 text-[12.5px] leading-snug text-ink-soft">
          {SETUP_STEPS.map((step, index) => (
            <li className="flex gap-2" key={step}>
              <span aria-hidden className="font-mono text-[11px] leading-5 text-muted-2">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        <pre
          className="m-0 max-h-[34dvh] overflow-auto whitespace-pre-wrap bg-surface-subtle p-4 font-mono text-[12px] leading-relaxed text-ink"
          data-testid="yc-setup-prompt"
        >
          {prompt}
        </pre>
      </section>

      <GrantLine grant={state.grant} />
      <KeyLine
        keyPrefix={state.keyPrefix}
        keySecret={state.keySecret}
        keySuffix={state.keySuffix}
        webBaseUrl={webBaseUrl}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link className={buttonClassName("primary")} href={overviewPath()}>
          Go to Overview
        </Link>
        <p className="m-0 text-[13px] leading-snug text-muted">
          Your balances and spend live on{" "}
          <Link
            className="font-medium text-ink underline underline-offset-2"
            href={creditsPath()}
          >
            Credits
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

function GrantLine({ grant }: { grant: GrantState }) {
  // A fresh claim is the celebratory success moment: mirror the login modal's
  // success step with the applied amount over a one-shot ConfettiBurst.
  if (grant.kind === "granted") {
    return <GrantCelebration grantedUsd={grant.grantedUsd} expiresAt={grant.expiresAt} />;
  }
  // A returning founder's active grant stays a quiet status line: the money
  // already landed on a prior visit, so no re-celebration.
  if (grant.kind === "active") {
    return (
      <div
        className="flex items-center gap-2 rounded-[var(--radius-md)] border border-line-strong bg-surface px-3 py-2"
        data-testid="yc-grant-panel"
        role="status"
      >
        <Check aria-hidden className="shrink-0 text-accent" size={16} strokeWidth={2} />
        <p className="m-0 text-[13px] leading-snug text-ink">
          <span className="font-semibold">Your org is already on the YC grant</span>{" "}
          <span className="text-muted">
            {formatSignedCostUsd(grant.remainingUsd)} unspent, expiring{" "}
            <LocalDateTime value={grant.expiresAt} withYear />.
          </span>
        </p>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-0.5 rounded-[var(--radius-md)] border border-line-strong bg-surface px-3 py-2"
      role="status"
    >
      <p className="m-0 text-[13px] font-semibold text-ink">{grant.message}</p>
      <p className="m-0 text-[13px] leading-snug text-muted">
        {grant.kind === "conflict" ? RECOVERY_LINE : "Refresh to retry, or " + RECOVERY_LINE}
      </p>
    </div>
  );
}

/**
 * The claim-success celebration: the auto-claim just landed the launch grant,
 * so the surface earns the same moment the login modal's success step gets:
 * a one-shot ConfettiBurst behind a prominent "credits applied" line. The
 * burst fills this positioned card and clears itself after ~1.1s (and renders
 * nothing under prefers-reduced-motion).
 */
function GrantCelebration({ grantedUsd, expiresAt }: { grantedUsd: number; expiresAt: string }) {
  return (
    <div
      className="relative overflow-hidden rounded-[var(--radius-md)] border border-line-strong bg-surface px-4 py-3"
      data-testid="yc-grant-panel"
      role="status"
    >
      <ConfettiBurst />
      <div className="relative flex items-center gap-2.5">
        <Check aria-hidden className="shrink-0 text-accent" size={18} strokeWidth={2} />
        <div className="min-w-0">
          <p
            className="m-0 text-[15px] font-semibold leading-tight tracking-tight text-ink"
            data-testid="yc-grant-applied"
          >
            {formatGrantUsd(grantedUsd)} in credits applied
          </p>
          <p className="m-0 mt-0.5 text-[13px] leading-snug text-muted">
            Expires <LocalDateTime value={expiresAt} withYear />.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The key the prompt authenticates with. A fresh secret renders once with its
 * copy control (hash-only storage — this is the one look, like the settings
 * mint flow); an org that already holds a key gets its recognition prefix and
 * the pointer to mint another.
 */
function KeyLine({
  keySecret,
  keyPrefix,
  keySuffix,
  webBaseUrl
}: {
  keySecret: string | null;
  keyPrefix: string | null;
  keySuffix: string | null;
  webBaseUrl: string;
}) {
  if (keySecret !== null) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-line-strong bg-surface-subtle px-3 py-2">
        <code className="overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-ink">
          {keySecret}
        </code>
        <CopyButton label="Copy API key" text={keySecret} />
      </div>
    );
  }
  return (
    <p className="m-0 text-[13px] leading-snug text-muted">
      {keyPrefix !== null
        ? `Your org already holds an API key (${formatKeyIdentity(keyPrefix, keySuffix)}); it works as-is, and the prompt above says where to paste it. `
        : "Ask an org admin for an API key; the prompt above says where it goes. "}
      Keys are managed at {webBaseUrl}/api-keys.
    </p>
  );
}

/** GET /api/welcome — the same read the login modal's success step uses. */
async function readYcWelcome(): Promise<WelcomeRead | null> {
  try {
    const response = await fetch("/api/welcome", { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json().catch(() => null)) as {
      org?: { id?: unknown };
      apiKey?: { keyPrefix?: unknown; keySuffix?: unknown } | null;
      canManageKeys?: unknown;
    } | null;
    if (typeof payload?.org?.id !== "string" || typeof payload.canManageKeys !== "boolean") {
      return null;
    }
    const prefix = payload.apiKey?.keyPrefix;
    const suffix = payload.apiKey?.keySuffix;
    return {
      orgId: payload.org.id,
      keyPrefix: typeof prefix === "string" ? prefix : null,
      keySuffix: typeof suffix === "string" ? suffix : null,
      canManageKeys: payload.canManageKeys
    };
  } catch {
    return null;
  }
}

/**
 * The auto-claim: logging in through the YC link IS the claim, so this fires
 * on mount with no button. Idempotent by the backend's uniqueness pair — a
 * duplicate answers 409, and the budget read then supplies the live grant
 * state so a returning founder sees what they have, not an error.
 */
async function claimGrant(orgId: string): Promise<GrantState> {
  try {
    const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/yc/claim`, {
      method: "POST"
    });
    const payload = (await response.json().catch(() => null)) as {
      granted_usd?: unknown;
      expires_at?: unknown;
      error?: unknown;
      code?: unknown;
    } | null;
    if (
      response.ok &&
      typeof payload?.granted_usd === "number" &&
      typeof payload.expires_at === "string"
    ) {
      captureTelemetryEvent("yc_grant_claimed", { granted_usd: payload.granted_usd });
      return { kind: "granted", grantedUsd: payload.granted_usd, expiresAt: payload.expires_at };
    }
    const message =
      typeof payload?.error === "string" ? payload.error : "The credit grant didn't go through.";
    if (response.status === 409 && payload?.code === "yc_already_claimed") {
      const active = await readActiveClaim(orgId);
      if (active !== null) {
        return {
          kind: "active",
          remainingUsd: active.remaining_estimate_usd,
          expiresAt: active.expires_at
        };
      }
      // The backend's message renders verbatim — it is the copy the product owner wrote
      // the recovery line against.
      return { kind: "conflict", message };
    }
    return { kind: "failed", message };
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : "The credit grant didn't go through."
    };
  }
}

/** The org's unexpired grant from the budget payload, null when none. */
async function readActiveClaim(orgId: string): Promise<YcClaimState | null> {
  try {
    const response = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/budget`, {
      cache: "no-store"
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json().catch(() => null)) as {
      budget?: { yc?: YcClaimState | null };
    } | null;
    return payload?.budget?.yc ?? null;
  } catch {
    return null;
  }
}

/** First key for a fresh workspace, via the same mint route the settings use. */
async function mintDefaultKey(orgId: string): Promise<string | null> {
  try {
    const response = await fetch("/api/keys", {
      body: JSON.stringify({ orgId, name: "default", expiresInDays: null }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json().catch(() => null)) as { secret?: unknown } | null;
    return typeof payload?.secret === "string" ? payload.secret : null;
  } catch {
    return null;
  }
}

/**
 * Clipboard control; flips to a check for a beat after copying. `prominent`
 * renders the primary labelled button that fronts the paste CTA (the page's
 * main action); the default is the small icon control for the API key row.
 */
function CopyButton({
  text,
  label,
  prominent = false
}: {
  text: string;
  label: string;
  prominent?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  if (prominent) {
    return (
      <button
        aria-label={label}
        className={buttonClassName("primary", "shrink-0")}
        onClick={copy}
        type="button"
      >
        {copied ? <Check aria-hidden size={15} /> : <Copy aria-hidden size={15} />}
        {copied ? "Copied" : "Copy prompt"}
      </button>
    );
  }
  return (
    <button
      aria-label={label}
      className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-[var(--radius-md)] border border-line-strong text-muted transition-colors hover:bg-surface-subtle hover:text-ink"
      onClick={copy}
      type="button"
    >
      {copied ? <Check aria-hidden size={13} /> : <Copy aria-hidden size={13} />}
    </button>
  );
}
