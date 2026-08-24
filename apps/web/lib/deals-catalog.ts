import { isAiCallableProvider } from "@/lib/billing/provider-balances";
import type { ModelProvider } from "@/lib/model-providers";

// Inference credit YC deals, one per connectable provider, each linking to
// its Bookface deal page. The URL-to-provider mapping is the FINAL one the product owner
// verified on 2026-08-22 (Bookface is behind YC login, so it is not checkable
// from here): OpenAI 1597, Anthropic 2153, OpenRouter 3222, Google 4, AWS 3,
// Microsoft 2155, Fireworks 2926, Modal 1682. Headlines stay generic: we do
// not carry per-deal dollar figures we cannot verify. Matched on /credits
// against the providers the org has connected.

export type Deal = {
  /** Stable id for keys and tests. */
  id: string;
  /** Vendor name as shown. */
  name: string;
  /**
   * The connectable inference provider this deal belongs to. A connected
   * account moves the deal into the "claim" group, and a YC org's provider
   * tile links its deal from here.
   */
  provider: ModelProvider;
  /** Generic, non-numeric headline (no unverified dollar figures). */
  headline: string;
  /** The Bookface deal page (YC login required). */
  url: string;
};

export const DEAL_CATALOG: readonly Deal[] = [
  {
    id: "openai",
    name: "OpenAI",
    provider: "openai",
    headline: "API credits",
    url: "https://bookface.ycombinator.com/deals/1597"
  },
  {
    id: "anthropic",
    name: "Anthropic",
    provider: "anthropic",
    headline: "Claude API credits",
    url: "https://bookface.ycombinator.com/deals/2153"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    provider: "openrouter",
    headline: "Routing credits",
    url: "https://bookface.ycombinator.com/deals/3222"
  },
  {
    id: "google",
    name: "Google",
    provider: "gemini",
    headline: "Credits that cover Gemini",
    url: "https://bookface.ycombinator.com/deals/4"
  },
  {
    id: "aws",
    name: "AWS",
    provider: "bedrock",
    headline: "Credits that cover Bedrock",
    url: "https://bookface.ycombinator.com/deals/3"
  },
  {
    id: "microsoft",
    name: "Microsoft",
    provider: "azure_openai",
    headline: "Credits that cover Azure Foundry",
    url: "https://bookface.ycombinator.com/deals/2155"
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    provider: "fireworks",
    headline: "Inference credits",
    url: "https://bookface.ycombinator.com/deals/2926"
  },
  {
    id: "modal",
    name: "Modal",
    provider: "modal",
    headline: "Compute credits",
    url: "https://bookface.ycombinator.com/deals/1682"
  }
];

export type MatchedDeals = {
  /** Deals for a provider the org has connected: credits it can claim now. */
  claim: Deal[];
  /** Every other deal, in catalog order. */
  available: Deal[];
};

/**
 * Match the catalog against the inference providers the org has connected. A
 * connected provider moves its deals into `claim` ("you use this, claim your
 * credits"); everything else stays available. Honest and simple: no
 * personalization beyond "you have this key connected".
 */
export function matchDeals(connectedProviders: readonly ModelProvider[]): MatchedDeals {
  const connected = new Set(connectedProviders.filter(isAiCallableProvider));
  const claim: Deal[] = [];
  const available: Deal[] = [];
  for (const deal of DEAL_CATALOG) {
    (connected.has(deal.provider) ? claim : available).push(deal);
  }
  return { claim, available };
}

/** One provider's Bookface deals, catalog order; empty when it has none. */
export function dealsForProvider(provider: ModelProvider): Deal[] {
  return DEAL_CATALOG.filter((deal) => deal.provider === provider);
}
