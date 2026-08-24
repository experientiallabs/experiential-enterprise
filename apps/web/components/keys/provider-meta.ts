"use client";

// Per-provider display vocabulary for KeyHub: the glyph, how a connection is
// hooked up (the product owner: rows state their connection method plainly), what
// connecting takes for a provider that is not hooked up yet, and the honest
// spend/credits line for whatever the provider can actually report.

import { Asterisk, Boxes, Cloud, Flame, Gem, Layers, Sparkles, Waypoints } from "lucide-react";

import { providerConnectionStatusLabel } from "@/lib/format";
import { formatCostUsd, formatSignedCostUsd } from "@/lib/money";
import type { ModelProvider } from "@/lib/model-providers";
import type { ProviderConnectionSummary } from "@/lib/provider-connections";

/** One recognizable glyph per provider account. */
export const PROVIDER_ICONS: Record<ModelProvider, typeof Sparkles> = {
  openai: Sparkles,
  anthropic: Asterisk,
  gemini: Gem,
  azure_openai: Cloud,
  openrouter: Waypoints,
  bedrock: Boxes,
  fireworks: Flame,
  modal: Layers
};

/** True when the connection carries the optional admin ("spend") key. */
export function hasSpendKey(connection: ProviderConnectionSummary): boolean {
  return connection.spend_credential_last4 !== null;
}

/** Whether this connection can produce a real provider/our-side spend reading. */
export function canReportSpend(connection: ProviderConnectionSummary): boolean {
  if (!connection.connected) {
    return false;
  }
  switch (connection.provider) {
    case "openrouter":
    case "bedrock":
    case "fireworks":
    case "modal":
      return true;
    case "anthropic":
    case "openai":
      return hasSpendKey(connection);
    case "gemini":
    case "azure_openai":
      // Gemini and Azure honestly report nothing (AI Studio keys expose no
      // billing; Azure data-plane keys read nothing from Cost Management).
      return false;
  }
}

/** "Hooked up and how": the connection method in plain words. */
export function hookupLine(connection: ProviderConnectionSummary): string {
  if (!connection.connected) {
    return "Not connected";
  }
  switch (connection.provider) {
    case "openai":
    case "anthropic":
      return hasSpendKey(connection) ? "API key + admin key (spend)" : "API key";
    case "gemini":
    case "openrouter":
    case "fireworks":
      return "API key";
    case "azure_openai": {
      const deployments = connection.config?.deployments;
      const count =
        typeof deployments === "object" && deployments !== null && !Array.isArray(deployments)
          ? Object.keys(deployments).length
          : 0;
      return `Azure key + ${count} ${count === 1 ? "deployment" : "deployments"}`;
    }
    case "bedrock": {
      const region = connection.config?.region;
      return typeof region === "string" && region.length > 0
        ? `AWS IAM keys (${region})`
        : "AWS IAM keys";
    }
    case "modal":
      return "Token pair";
  }
}

/** What connecting takes, shown on a provider's quiet "hook up" row. */
export function hookupNeeds(provider: ModelProvider): string {
  switch (provider) {
    case "openai":
    case "anthropic":
    case "openrouter":
      return "Needs an API key.";
    case "gemini":
      return "Needs an AI Studio API key.";
    case "azure_openai":
      return "Needs the resource endpoint, an API key, and the deployment name per model.";
    case "bedrock":
      return "Needs AWS IAM keys and the region Bedrock requests should call.";
    case "fireworks":
      return "Needs an API key and the account id (the account slug on fireworks.ai).";
    case "modal":
      return "Needs a token pair: token id (ak-…) and token secret (as-…).";
  }
}

/**
 * The spend/credits cell, honest per provider capability: real snapshot
 * figures when the provider reports them, the self-reported gauge when that
 * is all we have, and a plain "doesn't report this" where nothing exists —
 * never blank for a connected row.
 */
export function spendSummary(connection: ProviderConnectionSummary): string {
  if (!connection.connected) {
    return "—";
  }
  const snapshot = connection.latest_snapshot;
  if (snapshot !== null) {
    const parts: string[] = [];
    if (snapshot.spend_usd !== null) {
      parts.push(`${formatCostUsd(snapshot.spend_usd)} this month`);
    }
    if (snapshot.credits_remaining_usd !== null) {
      parts.push(
        snapshot.usage_limit_usd !== null
          ? `credits: ${formatCostUsd(snapshot.credits_remaining_usd)} left / limit ${formatCostUsd(snapshot.usage_limit_usd)}`
          : `credits: ${formatCostUsd(snapshot.credits_remaining_usd)} left`
      );
    }
    if (parts.length > 0) {
      return parts.join(" · ");
    }
  }
  // No provider read yet — fall back to the customer's own gauge, drawn down
  // by what we metered through the key since they declared it.
  if (connection.declared_balance_usd !== null) {
    const remaining = connection.declared_balance_usd - connection.metered_spend_usd;
    return `self-reported: ${formatSignedCostUsd(remaining)} left`;
  }
  switch (connection.provider) {
    case "gemini":
      return "Google doesn't report this";
    case "azure_openai":
      return "Azure doesn't report this";
    case "anthropic":
    case "openai":
      return "connect an admin key to see spend";
    case "openrouter":
    case "bedrock":
    case "fireworks":
    case "modal":
      return "no spend data yet";
  }
}

/**
 * The stored admin key's own problem, when it has one. Its verdict lives
 * under status_detail.spend_key and never touches the key-level status (an
 * admin key only reads spend); a non-valid verdict is surfaced beside the
 * connection rather than as the row's status.
 */
export function spendKeyProblem(detail: Record<string, unknown> | null): string | null {
  const spendKey = detail?.spend_key;
  if (typeof spendKey !== "object" || spendKey === null || Array.isArray(spendKey)) {
    return null;
  }
  const verdict = spendKey as Record<string, unknown>;
  if (verdict.status === "valid" || typeof verdict.status !== "string") {
    return null;
  }
  const remediation = typeof verdict.remediation === "string" ? verdict.remediation : null;
  const providerMessage =
    typeof verdict.provider_message === "string" ? verdict.provider_message : null;
  return remediation ?? providerMessage ?? `The admin key came back ${verdict.status}.`;
}

/**
 * The stored verdict in full for the expanded row: our remediation text
 * (self-sufficient by contract), with the provider's raw words behind it when
 * they add anything.
 */
export function storedStatusMessage(connection: ProviderConnectionSummary): string {
  const detail = connection.status_detail;
  const remediation = typeof detail?.remediation === "string" ? detail.remediation : null;
  const providerMessage =
    typeof detail?.provider_message === "string" ? detail.provider_message : null;
  if (remediation !== null) {
    return providerMessage !== null && !remediation.includes(providerMessage)
      ? `${remediation} (Provider said: "${providerMessage}")`
      : remediation;
  }
  if (providerMessage !== null) {
    return `${providerConnectionStatusLabel(connection.status)}: ${providerMessage}`;
  }
  return providerConnectionStatusLabel(connection.status);
}
