"use client";

// Bring your own model: one form creates the catalog row, its local
// OpenAI-compatible route, and the default chain (POST /api/models), and
// lands on the new detail page with the call-it-now snippet. Custom models
// are org-private end to end — catalog, detail, and GET /v1/models. The page
// frame renders signed out; the login modal opens on arrival and the submit
// is wrapped in requireAuth (design-system gating contract).

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { Button } from "@/components/ui/Button";
import { isReservedRouteSlug } from "@/lib/routes";
import type { ModelDetail } from "@/lib/models-catalog/types";

const SLUG_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
// Static siblings of /models/[modelSlug]; a model with one of these slugs
// would be unreachable behind its own detail route.
const RESERVED_MODEL_SLUGS = new Set(["new", "compare"]);

const MODALITY_OPTIONS = ["text", "image", "audio", "video", "pdf"];
const PARAM_OPTIONS = [
  "tools",
  "temperature",
  "reasoning",
  "response_format",
  "structured_outputs"
];

export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/-{2,}/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/[-.]+$/, "")
    .slice(0, 128);
}

export function slugProblem(slug: string): string | null {
  if (!SLUG_PATTERN.test(slug)) {
    return "Slugs start with a letter and use lowercase letters, digits, dots, dashes, or underscores.";
  }
  if (RESERVED_MODEL_SLUGS.has(slug) || isReservedRouteSlug(slug)) {
    return `"${slug}" is reserved by the app's own pages; pick another slug.`;
  }
  return null;
}

/** Dollars-per-million text input -> integer micro-USD, or null when blank. */
export function microFromUsdText(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  const usd = Number(trimmed);
  if (!Number.isFinite(usd) || usd < 0) {
    return undefined;
  }
  return Math.round(usd * 1_000_000);
}

export function CustomModelForm({ orgId }: { orgId: string | null }) {
  const router = useRouter();
  const { open: openLogin, requireAuth } = useLoginModal();
  const promptedRef = useRef(false);

  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [providerModelId, setProviderModelId] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutput, setMaxOutput] = useState("");
  const [modalities, setModalities] = useState<string[]>(["text"]);
  const [params, setParams] = useState<string[]>(["tools", "temperature"]);
  const [inputUsd, setInputUsd] = useState("");
  const [outputUsd, setOutputUsd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The form is an authenticated act from the first keystroke, so prompt on
  // arrival — the page frame stays rendered behind the modal.
  useEffect(() => {
    if (orgId === null && !promptedRef.current) {
      promptedRef.current = true;
      openLogin();
    }
  }, [orgId, openLogin]);

  const effectiveSlug = slugTouched ? slug : slugFromName(displayName);
  const slugError = useMemo(
    () => (effectiveSlug === "" ? null : slugProblem(effectiveSlug)),
    [effectiveSlug]
  );

  const submit = async () => {
    if (orgId === null) {
      openLogin();
      return;
    }
    if (slugError !== null || effectiveSlug === "") {
      setError(slugError ?? "Pick a name first.");
      return;
    }
    const inputMicro = microFromUsdText(inputUsd);
    const outputMicro = microFromUsdText(outputUsd);
    if (inputMicro === undefined || outputMicro === undefined) {
      setError("Prices must be non-negative dollar amounts per million tokens.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/models", {
        body: JSON.stringify({
          context_window: contextWindow.trim() === "" ? undefined : Number(contextWindow),
          description: description.trim() === "" ? undefined : description.trim(),
          display_name: displayName.trim(),
          input_modalities: modalities,
          max_output_tokens: maxOutput.trim() === "" ? undefined : Number(maxOutput),
          org_id: orgId,
          output_modalities: ["text"],
          providers: [
            {
              base_url: baseUrl.trim(),
              input_micro_usd_per_million: inputMicro ?? undefined,
              output_micro_usd_per_million: outputMicro ?? undefined,
              pricing_source: inputMicro === null && outputMicro === null ? undefined : "self-reported",
              provider: "local",
              provider_model_id:
                providerModelId.trim() === "" ? effectiveSlug : providerModelId.trim()
            }
          ],
          slug: effectiveSlug,
          supported_params: Object.fromEntries(params.map((param) => [param, true]))
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      const payload = (await response.json()) as ModelDetail & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `Creating the model failed (HTTP ${response.status})`);
      }
      router.push(`/models/${encodeURIComponent(payload.model.slug)}?created=1`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Creating the model failed.");
      setSubmitting(false);
    }
  };

  const toggle = (list: string[], setList: (next: string[]) => void, value: string) => {
    setList(list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
  };

  return (
    <form
      className="flex max-w-3xl flex-col gap-5"
      data-testid="custom-model-form"
      onSubmit={(event) => {
        event.preventDefault();
        requireAuth(() => void submit());
      }}
    >
      <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-[18px]">
        <p className="mono-label m-0">Model</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Display name">
            <TextInput
              onChange={(value) => setDisplayName(value)}
              placeholder="My fine-tuned coder"
              required
              value={displayName}
            />
          </Field>
          <Field
            error={slugError}
            hint="Becomes the model id you call through the gateway."
            label="Slug"
          >
            <TextInput
              mono
              onChange={(value) => {
                setSlugTouched(true);
                setSlug(value);
              }}
              placeholder="my-fine-tuned-coder"
              value={effectiveSlug}
            />
          </Field>
        </div>
        <Field label="Description (optional)">
          <TextInput
            onChange={(value) => setDescription(value)}
            placeholder="What this model is good at"
            value={description}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Context window (tokens, optional)">
            <TextInput
              mono
              inputMode="numeric"
              onChange={(value) => setContextWindow(value.replaceAll(/[^0-9]/g, ""))}
              placeholder="131072"
              value={contextWindow}
            />
          </Field>
          <Field label="Max output tokens (optional)">
            <TextInput
              mono
              inputMode="numeric"
              onChange={(value) => setMaxOutput(value.replaceAll(/[^0-9]/g, ""))}
              placeholder="16384"
              value={maxOutput}
            />
          </Field>
        </div>
        <Field label="Input modalities">
          <ToggleRow
            onToggle={(value) => {
              // "text" stays: the schema requires at least one modality and
              // every chat model reads text.
              if (value !== "text") {
                toggle(modalities, setModalities, value);
              }
            }}
            options={MODALITY_OPTIONS}
            selected={modalities}
          />
        </Field>
        <Field label="Supported parameters">
          <ToggleRow
            onToggle={(value) => toggle(params, setParams, value)}
            options={PARAM_OPTIONS}
            selected={params}
          />
        </Field>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-[18px]">
        <p className="mono-label m-0">Endpoint</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field hint="An OpenAI-compatible server you run." label="Base URL">
            <TextInput
              mono
              onChange={(value) => setBaseUrl(value)}
              placeholder="https://your-host:8000/v1"
              required
              type="url"
              value={baseUrl}
            />
          </Field>
          <Field hint="Defaults to the slug." label="Served model id (optional)">
            <TextInput
              mono
              onChange={(value) => setProviderModelId(value)}
              placeholder={effectiveSlug === "" ? "model id your server expects" : effectiveSlug}
              value={providerModelId}
            />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-[18px]">
        <p className="mono-label m-0">Pricing (optional)</p>
        <p className="m-0 max-w-[640px] text-[12.5px] leading-relaxed text-muted">
          Used for spend accounting on your usage pages. Leave blank for unpriced — unpriced usage
          shows — , never $0.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Input $ / M tokens">
            <TextInput
              mono
              inputMode="decimal"
              onChange={(value) => setInputUsd(value)}
              placeholder="0.50"
              value={inputUsd}
            />
          </Field>
          <Field label="Output $ / M tokens">
            <TextInput
              mono
              inputMode="decimal"
              onChange={(value) => setOutputUsd(value)}
              placeholder="1.50"
              value={outputUsd}
            />
          </Field>
        </div>
      </section>

      {error !== null ? <p className="m-0 text-[12.5px] text-danger">{error}</p> : null}
      <div>
        <Button loading={submitting} type="submit" variant="accent">
          Create model
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  error,
  children
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[12.5px] font-semibold text-ink-soft">
      {label}
      {children}
      {error ? (
        <span className="font-normal text-danger">{error}</span>
      ) : hint ? (
        <span className="font-normal text-muted-2">{hint}</span>
      ) : null}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  required,
  type = "text",
  inputMode,
  mono = false
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: string;
  inputMode?: "numeric" | "decimal";
  mono?: boolean;
}) {
  return (
    <input
      className={`min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 text-[13px] font-normal text-ink placeholder:text-muted-2 focus:border-accent focus:outline-none ${
        mono ? "font-mono text-[12.5px]" : ""
      }`}
      inputMode={inputMode}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      required={required}
      type={type}
      value={value}
    />
  );
}

function ToggleRow({
  options,
  selected,
  onToggle
}: {
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {options.map((option) => {
        const active = selected.includes(option);
        return (
          <button
            aria-pressed={active}
            className={`inline-flex min-h-[28px] cursor-pointer items-center rounded-full border px-2.5 font-mono text-[11px] transition-colors ${
              active
                ? "border-accent/40 bg-accent-soft text-accent"
                : "border-line-strong bg-surface text-ink-soft hover:text-ink"
            }`}
            key={option}
            onClick={() => onToggle(option)}
            type="button"
          >
            {option.replaceAll("_", " ")}
          </button>
        );
      })}
    </span>
  );
}
