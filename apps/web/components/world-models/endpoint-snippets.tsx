import type { ReactNode } from "react";

/** Copyable hosted Chat Completions snippets and their presentation pieces. */

/**
 * The hosted platform's serving API. THE one source of truth for the
 * local-vs-platform switch (the product owner, 2026-07-30): every base-URL mention in the
 * product resolves through this module - hosted domain by default, and a
 * deployment that is not the hosted platform (the local Docker stack, a
 * self-host) overrides it with EXPLABS_PUBLIC_BACKEND_URL. Never write this
 * host as a literal anywhere else.
 */
export const PLATFORM_SERVING_BASE_URL = "https://api.experientiallabs.ai";

/**
 * The deployment's configured public backend URL, when one is set: trimmed,
 * trailing slash stripped, null when absent or empty. Prefers
 * EXPLABS_PUBLIC_BACKEND_URL for deployments where the web server reaches the
 * backend over an internal address a customer cannot use (the local Docker
 * stack's http://api:8080). /api/cli/config shares this exact resolution.
 */
export function configuredServingBaseUrl(): string | null {
  const raw = process.env.EXPLABS_PUBLIC_BACKEND_URL ?? process.env.EXPLABS_BACKEND_URL ?? "";
  const normalized = raw.trim().replace(/\/$/, "");
  return normalized || null;
}

/**
 * Normalize a configured backend URL for snippet interpolation: strip a
 * trailing slash, and fall back to the hosted platform when unset or empty.
 */
export function resolveServingBaseUrl(configured: string | undefined): string {
  return (configured ?? "").trim().replace(/\/$/, "") || PLATFORM_SERVING_BASE_URL;
}

/** The customer-facing serving host for copyable snippets and docs. */
export function publicServingBaseUrl(): string {
  return configuredServingBaseUrl() ?? PLATFORM_SERVING_BASE_URL;
}

/**
 * Escape free text for a JSON string embedded in a shell single-quoted
 * argument: JSON-escape first (quotes, backslashes, newlines), then close and
 * reopen the surrounding single quotes around any literal quote character.
 * No-op for text without quotes/backslashes, so default snippets render
 * byte-identically.
 */
function shellJsonText(value: string): string {
  return JSON.stringify(value).slice(1, -1).replace(/'/g, `'\\''`);
}

export type ChatCompletionsSnippets = {
  http: string;
  curl: string;
  python: string;
};

export type ChatCompletionsOptions = {
  /** Bearer value shown in each example; defaults to the environment placeholder. */
  bearer?: string;
  /** User message shown in each example. */
  task?: string;
};

/**
 * The OpenAI-compatible call pair for one optimized model: the integration
 * story is a base_url swap, so both snippets show exactly that. Rendered by
 * the model detail page's serving card and the playground's use-it hint.
 */
export function chatCompletionsSnippets(
  modelName: string,
  baseUrl: string,
  options: ChatCompletionsOptions = {}
): ChatCompletionsSnippets {
  const bearer = options.bearer ?? "$EXPLABS_API_KEY";
  const task = shellJsonText(options.task ?? "Hello from my product");
  const body = `{"model": "${modelName}", "stream": true, "messages": [{"role": "user", "content": "${task}"}]}`;
  return {
    http: [
      "POST /v1/chat/completions HTTP/1.1",
      `Host: ${hostOf(baseUrl)}`,
      `Authorization: Bearer ${bearer}`,
      "Content-Type: application/json",
      "",
      body
    ].join("\n"),
    curl: [
      `curl "${baseUrl}/v1/chat/completions" \\`,
      `  -H "Authorization: Bearer ${bearer}" \\`,
      '  -H "Content-Type: application/json" \\',
      `  -d '{"model": "${modelName}", "stream": true, "messages": [{"role": "user", "content": "${task}"}]}'`
    ].join("\n"),
    python: [
      "import os",
      "",
      "from openai import OpenAI",
      "",
      `client = OpenAI(base_url="${baseUrl}/v1", api_key=os.environ["EXPLABS_API_KEY"])`,
      "response = client.chat.completions.create(",
      `    model="${modelName}",`,
      "    stream=True,",
      `    messages=[{"role": "user", "content": ${JSON.stringify(options.task ?? "Hello from my product")}}],`,
      ")"
    ].join("\n")
  };
}

/** Host for the raw-HTTP snippet; the placeholder passes through verbatim. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function EndpointCard({
  title,
  children,
  className
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`border border-line rounded-lg bg-surface p-[18px] ${className ?? ""}`}>
      <p className="m-0 mb-3 text-foreground/25 text-[11px] font-medium tracking-[0.04em] uppercase">
        {title}
      </p>
      {children}
    </section>
  );
}

export function Snippet({ text, wrap = false }: { text: string; wrap?: boolean }) {
  // Code scrolls horizontally to preserve exact formatting; prose (an agent
  // prompt) wraps so long lines stay readable inside a fixed-width card.
  return (
    <pre
      className={`m-0 rounded-[var(--radius-md)] bg-background p-3 font-mono text-[12.5px] leading-relaxed ${
        wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto"
      }`}
    >
      {text}
    </pre>
  );
}
