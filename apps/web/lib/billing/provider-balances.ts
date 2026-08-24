import { MODEL_PROVIDERS, type ModelProvider } from "@/lib/model-providers";
import type { ProviderConnectionState } from "@/components/settings/ModelProvidersPanel";

// The balances/spend surfaces on /credits show INFERENCE PROVIDERS ONLY — the
// accounts you can actually call AI from (SCOPE CORRECTION 2026-08-19). Tool
// accounts (PostHog, Arize, Resend, Porter, E2B, Cursor, LinkedIn, Braintrust,
// Supabase) are not AI-callable and never belong on the credits balances view.
// They already live in a different table (trace_connections), so provider
// balances start clean; this allowlist is the explicit, future-proof filter so
// a non-inference provider added to provider_connections later cannot leak onto
// the money page. Every current model provider is AI-callable, so nothing is
// dropped today — the guard is the point.
export const AI_CALLABLE_PROVIDERS: readonly ModelProvider[] = MODEL_PROVIDERS;

export function isAiCallableProvider(provider: ModelProvider): boolean {
  return AI_CALLABLE_PROVIDERS.includes(provider);
}

/**
 * Every known provider as an unconnected state. The signed-out /credits page
 * renders the balances view without any account-scoped read, so it passes this:
 * each provider shows an honest "connect to see balance", never a fake figure.
 */
export const DISCONNECTED_PROVIDER_CONNECTIONS: ProviderConnectionState[] = MODEL_PROVIDERS.map(
  (provider) => ({
    provider,
    connected: false,
    credentialLast4: null,
    config: null,
    updatedAt: null,
    status: "unchecked",
    statusDetail: null,
    statusCheckedAt: null,
    spendCredentialLast4: null,
    declaredBalanceUsd: null,
    declaredBalanceSetAt: null,
    meteredSpendUsd: 0,
    lowBalanceThresholdUsd: 5,
    latestSnapshot: null
  })
);

/** Keep only the inference-provider connections; drop anything non-AI-callable. */
export function aiCallableConnections(
  connections: readonly ProviderConnectionState[]
): ProviderConnectionState[] {
  return connections.filter((connection) => isAiCallableProvider(connection.provider));
}

/**
 * What is left on the provider account: the balance the customer declared minus
 * what we metered through the key since. Null when no balance is tracked — we
 * cannot read most providers directly, so an untracked account has no honest
 * figure to show (never a fake $0). Kept here so the settings panel and the
 * credits balances view compute "remaining" one way.
 */
export function providerRemainingBalance(connection: ProviderConnectionState): number | null {
  if (connection.declaredBalanceUsd === null) {
    return null;
  }
  return connection.declaredBalanceUsd - connection.meteredSpendUsd;
}

/** A tracked balance at or below the connection's low-balance threshold. */
export function providerBalanceLow(connection: ProviderConnectionState): boolean {
  const remaining = providerRemainingBalance(connection);
  return remaining !== null && remaining <= connection.lowBalanceThresholdUsd;
}
