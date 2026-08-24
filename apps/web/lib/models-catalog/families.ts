// Model family derivation: which brand family a catalog model belongs to, so
// the catalog can group by family (Claude, GPT, Gemini, Qwen …) rather than by
// the raw provider route. Kept free of React so the ranking and grouping logic
// — and its unit suite — share the exact derivation the UI renders. The logo
// paint is separate: components/models-catalog/model-icon.tsx maps the same
// `models.icon` key to a glyph.
//
// The catalog's `models.icon` column (catalog-data-r2) is the authority: a
// lowercase family key that IS the grouping key. When it is populated we group
// by it directly; when it is null (an org's own model, or before that data
// lands) we fall back to name/slug rules that produce the SAME vocabulary, so a
// derived Claude and a tagged Claude never split into two groups.

import type { CatalogEntry, CatalogModel } from "./types";

/** A model's brand family: the grouping key and its display label. */
export type ModelFamily = {
  /** Stable grouping key (also the sort/group identity), the icon vocabulary. */
  key: string;
  /** Display label for the group header. */
  label: string;
};

// The family-key vocabulary → the maker label users read. Keys are the icon
// vocabulary painted by components/models-catalog/model-icon.tsx; a key with no
// mark there renders a monogram tile drawn from the model's name. Labels name
// the maker (or its best-known model line, e.g. Solar for Upstage) the way the
// catalog groups them. Exported for the admin promotions panel's family
// multi-select (components/admin/PromotionsBrowse.tsx).
export const FAMILY_LABELS: Record<string, string> = {
  anthropic: "Claude",
  openai: "GPT",
  google: "Gemini",
  qwen: "Qwen",
  deepseek: "DeepSeek",
  moonshot: "Kimi",
  meta: "Llama",
  mistral: "Mistral",
  zai: "GLM",
  xai: "Grok",
  cohere: "Cohere",
  amazon: "Amazon",
  microsoft: "Microsoft",
  nvidia: "NVIDIA",
  perplexity: "Perplexity",
  nous: "Nous",
  minimax: "MiniMax",
  baidu: "Baidu",
  bytedance: "ByteDance",
  ai21: "AI21",
  jais: "Jais",
  stability: "Stability",
  voyage: "Voyage",
  writer: "Writer",
  luma: "Luma",
  twelvelabs: "TwelveLabs",
  stepfun: "StepFun",
  upstage: "Solar",
  allenai: "Molmo",
  blackforest: "FLUX",
  thinkingmachines: "Thinking Machines",
  fireworks: "Fireworks",
  openrouter: "Other"
};

/**
 * Maker rules for a model row, first match wins. `test` sees the lowercased
 * "display_name slug" haystack. The catalog serves every maker through a few
 * lanes (Bedrock/Azure Foundry/Fireworks/first-party), so the slug carries the
 * serving prefix (`azure_openai-…`, `bedrock-vendor.…`, `fireworks-models-…`)
 * while the vendor token and display name carry the real maker — the rules key
 * off the maker signal, never the serving lane, so an Azure-served Cohere model
 * groups under Cohere, not OpenAI. Third-party makers are matched before OpenAI
 * precisely because OpenAI is the serving lane for the whole Azure Foundry set.
 */
const FAMILY_RULES: Array<{ key: string; test: RegExp }> = [
  { key: "anthropic", test: /\bclaude\b/ },
  { key: "deepseek", test: /\bdeepseek/ },
  { key: "moonshot", test: /\bkimi\b|moonshot/ },
  { key: "zai", test: /\bglm\b|z-ai|zhipu/ },
  { key: "qwen", test: /\bqwen|\bqwq\b/ },
  { key: "google", test: /\bgemini|gemma/ },
  // Nous Hermes builds on Llama, so match Nous before the Llama rule.
  { key: "nous", test: /\bnous\b/ },
  { key: "meta", test: /\bllama|\bmeta\b/ },
  { key: "mistral", test: /mistral|mixtral|codestral|devstral|ministral/ },
  { key: "cohere", test: /\bcohere\b|command-r|command-a/ },
  { key: "ai21", test: /\bai21\b|jamba/ },
  { key: "jais", test: /\bjais\b/ },
  { key: "stability", test: /\bstable|stability|\bsd3\b/ },
  { key: "amazon", test: /\bnova\b|\btitan|\bamazon\b/ },
  { key: "nvidia", test: /nemotron|\bnvidia\b/ },
  { key: "microsoft", test: /\bphi|\bmai\b|mai-|microsoft/ },
  { key: "minimax", test: /minimax/ },
  { key: "baidu", test: /\bernie\b|paddleocr|\bbaidu\b/ },
  { key: "bytedance", test: /\bseed|bytedance/ },
  { key: "writer", test: /palmyra|\bwriter\b/ },
  { key: "voyage", test: /\bvoyage\b/ },
  { key: "luma", test: /\bluma\b/ },
  { key: "twelvelabs", test: /twelvelabs|marengo/ },
  { key: "stepfun", test: /stepfun|\bstep\b/ },
  { key: "upstage", test: /\bsolar\b|upstage/ },
  { key: "sakana", test: /\bsakana\b/ },
  { key: "allenai", test: /\bmolmo|\bolmo\b|allenai/ },
  { key: "xai", test: /\bgrok/ },
  { key: "blackforest", test: /\bflux/ },
  // Inkling is Thinking Machines Lab's model (seeded icon `thinkingmachines`),
  // served through Fireworks/Azure — key off the maker, not the lane.
  { key: "thinkingmachines", test: /\binkling\b/ },
  // OpenAI last: its serving lane (`azure_openai-…`) prefixes third-party
  // slugs, so match OpenAI's own product tokens, never the bare lane name.
  {
    key: "openai",
    test: /\bgpt|\bcodex\b|\bo1\b|\bo3\b|\bo4\b|dall-?e|\bsora\b|\bwhisper\b|\bdavinci\b|\bcurie\b|\bbabbage\b|\bada\b|text-embedding|text-search|text-similarity|computer-use|model-router|aoai/
  },
  { key: "fireworks", test: /firefunction|firesearch|firellava/ }
];

/** The label for a family key, falling back to the key itself capitalized. */
function labelFor(key: string): string {
  return FAMILY_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * The fallback family for a model with no `icon` and no rule match: the first
 * token of its display name, so "Kimi K2.6" and "Kimi K3" still group under
 * "Kimi" rather than scattering by provider route. Its `model.icon` is null, so
 * ModelIcon paints the lettered tile.
 */
function nameFamily(model: CatalogModel): ModelFamily {
  const first = model.display_name.trim().split(/\s+/)[0] ?? "";
  if (first === "") {
    return { key: "other", label: "Other" };
  }
  return { key: `name:${first.toLowerCase()}`, label: first };
}

/** The brand family for one model row: the `icon` column, then name rules. */
function familyForModel(model: CatalogModel): ModelFamily {
  const icon = model.icon?.trim();
  if (icon !== undefined && icon !== "") {
    return { key: icon, label: labelFor(icon) };
  }
  const haystack = `${model.display_name} ${model.slug}`.toLowerCase();
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(haystack)) {
      return { key: rule.key, label: labelFor(rule.key) };
    }
  }
  return nameFamily(model);
}

/** The brand family for one catalog entry: the `icon` column, then name rules. */
export function modelFamily(entry: CatalogEntry): ModelFamily {
  return familyForModel(entry.model);
}

/**
 * The maker/family key for one model, the vocabulary ModelIcon paints. The API
 * view does not carry an `icon` column, so this derivation — not the storefront
 * — decides every catalog logo; a `name:*` fallback key has no mark and renders
 * the model's own monogram tile.
 */
export function modelIconKey(model: CatalogModel): string {
  return familyForModel(model).key;
}

// Proprietary, API-only families: their weights are not published, so a model in
// one of them can never be self-hosted; it is only reachable through the
// vendor's (or a reseller's) API key. Everything else the catalog carries is
// treated as self-hostable: the open-weights families (Qwen, DeepSeek, Llama,
// Mistral, Kimi, GLM, Nemotron, Cohere's open line, Phi, Nous …), the generic
// "Other" bucket (which today holds open-weights routes like GLM/Seed/Solar),
// and an org's own custom models (frequently a local endpoint they already run).
// The catalog has no explicit weights/license column, so this family
// classification is the single source of truth (the product owner, round-2).
const PROPRIETARY_FAMILIES = new Set<string>([
  "anthropic", // Claude
  "openai", // GPT / o-series
  "google", // Gemini
  "xai", // Grok
  "amazon", // Nova / Titan
  "perplexity" // Sonar
]);

/**
 * Whether this model can actually be self-hosted (open weights), which decides
 * whether the model detail page offers "Add a local variant" beside "Add a key".
 * Gemma is Google's open-weights line and shares the proprietary "google" family
 * key with Gemini, so it is called out by name before the family check.
 */
export function isSelfHostable(model: CatalogModel): boolean {
  const haystack = `${model.display_name} ${model.slug}`.toLowerCase();
  if (/\bgemma\b/.test(haystack)) {
    return true;
  }
  return !PROPRIETARY_FAMILIES.has(familyForModel(model).key);
}

/** The family key alone — the DataTable grouping accessor. */
export function modelFamilyKey(entry: CatalogEntry): string {
  return modelFamily(entry).key;
}

/** True when two models share a brand family (the ranking's family boost). */
export function sameFamily(a: CatalogEntry, b: CatalogEntry): boolean {
  return modelFamilyKey(a) === modelFamilyKey(b);
}
