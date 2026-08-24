import {
  docsAnthropicPath,
  docsAuthenticationPath,
  docsBillingPath,
  docsCodingAgentsPath,
  docsCoreLoopPath,
  docsErrorsPath,
  docsModelsPath,
  docsPath,
  docsQuickstartPath,
  docsReferencePath,
  docsSetupPromptsPath,
  docsTelemetryPath
} from "@/lib/routes";

// The docs information architecture: the ONE ordered source the sidebar,
// search index, and prev/next footer all derive from, so a page added here is
// navigable everywhere at once. The admin-only internal reference
// (/docs/internal) is deliberately absent: it is registered as a route but
// never listed or indexed for the public audience.

export type DocsNavEntry = {
  title: string;
  path: string;
  /** One line under the title in search results; also feeds the match text. */
  description: string;
  /** Extra match terms a reader might type that the title does not contain. */
  keywords: readonly string[];
};

export type DocsNavGroup = {
  label: string;
  entries: readonly DocsNavEntry[];
};

export const DOCS_NAV: readonly DocsNavGroup[] = [
  {
    label: "Get started",
    entries: [
      {
        title: "Overview",
        path: docsPath(),
        description: "What the gateway is and every way an agent can use it.",
        keywords: ["introduction", "gateway", "platform", "agents"]
      },
      {
        title: "Quickstart",
        path: docsQuickstartPath(),
        description: "Sign in, copy your key, and make your first call in under a minute.",
        keywords: ["first call", "getting started", "base url", "streaming", "openai"]
      },
      {
        title: "Setup prompts",
        path: docsSetupPromptsPath(),
        description: "Copy-paste prompts that make your coding agent do the setup for you.",
        keywords: ["prompt", "onboarding", "paste", "agent", "signup", "account", "byok", "traces"]
      },
      {
        title: "The core loop",
        path: docsCoreLoopPath(),
        description: "Get a key, check credits, list models, call them, read usage.",
        keywords: ["api key", "credits", "usage", "cli", "wmo", "self-serve"]
      },
      {
        title: "Authentication",
        path: docsAuthenticationPath(),
        description: "The xpl_ key: how it looks, the Bearer header, and what one key can and cannot do.",
        keywords: ["api key", "xpl", "bearer", "token", "auth", "401", "scope", "x-api-key"]
      }
    ]
  },
  {
    label: "Guides",
    entries: [
      {
        title: "Coding agents",
        path: docsCodingAgentsPath(),
        description: "Route Claude Code, Conductor, Codex, OpenCode, Cline, and other agents through the gateway.",
        keywords: ["codex", "opencode", "cline", "claude code", "conductor", "cli", "terminal", "ide"]
      },
      {
        title: "Models",
        path: docsModelsPath(),
        description: "The catalog, provider waterfalls, BYOK keys, and local models.",
        keywords: ["catalog", "waterfall", "byok", "providers", "local models"]
      },
      {
        title: "Anthropic API",
        path: docsAnthropicPath(),
        description: "Call the gateway with the Anthropic Messages API and the Anthropic SDKs.",
        keywords: ["anthropic", "messages", "claude", "sdk", "v1/messages", "x-api-key", "streaming"]
      },
      {
        title: "Errors",
        path: docsErrorsPath(),
        description: "Every error code, what it means, and how to recover.",
        keywords: ["error codes", "retry", "envelope", "recovery", "status"]
      }
    ]
  },
  {
    label: "Billing & usage",
    entries: [
      {
        title: "Credits & billing",
        path: docsBillingPath(),
        description: "Platform credits, BYOK pass-through, spend limits, alerts, and auto-recharge.",
        keywords: ["credits", "billing", "spend", "budget", "limits", "tpm", "auto-recharge", "invoice", "cost"]
      },
      {
        title: "Telemetry",
        path: docsTelemetryPath(),
        description: "Read usage and spend over the API, and bring your own traces in as telemetry.",
        keywords: ["usage", "telemetry", "traces", "observability", "events", "rollup", "spend"]
      }
    ]
  },
  {
    label: "Reference",
    entries: [
      {
        title: "API reference",
        path: docsReferencePath(),
        description: "The OpenAI-compatible inference API and the management API.",
        keywords: ["endpoints", "chat completions", "responses", "management", "openapi"]
      }
    ]
  }
];

/** Every public docs page in sidebar order; prev/next and search walk this. */
export const DOCS_PAGES: readonly DocsNavEntry[] = DOCS_NAV.flatMap(
  (group) => group.entries
);

export type DocsPrevNext = {
  prev: DocsNavEntry | null;
  next: DocsNavEntry | null;
};

/** Neighbors of `pathname` in reading order; both null off the public tree. */
export function docsPrevNext(pathname: string): DocsPrevNext {
  const index = DOCS_PAGES.findIndex((entry) => entry.path === pathname);
  if (index === -1) {
    return { prev: null, next: null };
  }
  return {
    prev: DOCS_PAGES[index - 1] ?? null,
    next: DOCS_PAGES[index + 1] ?? null
  };
}
