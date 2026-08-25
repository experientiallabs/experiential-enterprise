"use client";

import { clsx } from "clsx";

import { formatPerCallUsd } from "@/lib/money";
import {
  availableControls,
  estimateResponseCostUsd,
  REASONING_EFFORTS,
  supportedAttachmentModalities,
  type ParamControlKind,
  type ParamState,
  type ReasoningEffort
} from "@/lib/playground/model-params";
import type { CatalogEntry } from "@/lib/models-catalog/types";

type ResponseUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
};

type ParamsRailProps = {
  entry: CatalogEntry | null;
  state: ParamState;
  onChange: (state: ParamState) => void;
  lastUsage: ResponseUsage | null;
};

/**
 * The right rail: the sampling/behavior controls the selected model actually
 * supports, and the last response's measured cost, tokens, and latency. The
 * control set is derived per model from its declared `supported_params`, so a
 * parameter the model would reject is never offered.
 */
export function ParamsRail({ entry, state, onChange, lastUsage }: ParamsRailProps) {
  const controls = entry === null ? [] : availableControls(entry.model);
  const has = (kind: ParamControlKind) => controls.includes(kind);
  const set = (patch: Partial<ParamState>) => onChange({ ...state, ...patch });
  const attachmentModalities = entry === null ? [] : supportedAttachmentModalities(entry.model);

  return (
    <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto lg:pb-1">
      <section className="rounded-lg border border-line bg-surface p-3.5">
        <h2 className="mono-label m-0">Parameters</h2>
        {entry === null ? (
          <p className="mt-2 text-[12px] text-ink-faint">Select a model to set its parameters.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-3.5">
            {has("temperature") ? (
              <SliderControl
                label="Temperature"
                max={2}
                onChange={(value) => set({ temperature: value })}
                onReset={() => set({ temperature: null })}
                step={0.1}
                value={state.temperature}
              />
            ) : null}
            {has("top_p") ? (
              <SliderControl
                label="Top P"
                max={1}
                onChange={(value) => set({ topP: value })}
                onReset={() => set({ topP: null })}
                step={0.05}
                value={state.topP}
              />
            ) : null}
            {has("max_tokens") ? (
              <NumberControl
                hint={
                  entry.model.max_output_tokens !== null
                    ? `up to ${entry.model.max_output_tokens.toLocaleString("en-US")}`
                    : undefined
                }
                label="Max response tokens"
                onChange={(value) => set({ maxTokens: value })}
                value={state.maxTokens}
              />
            ) : null}
            {has("reasoning_effort") ? (
              <div>
                <span className="block text-[12px] text-muted">Reasoning effort</span>
                <div className="mt-1.5 flex gap-1">
                  <EffortButton
                    active={state.reasoningEffort === null}
                    label="default"
                    onClick={() => set({ reasoningEffort: null })}
                  />
                  {REASONING_EFFORTS.map((effort) => (
                    <EffortButton
                      active={state.reasoningEffort === effort}
                      key={effort}
                      label={effort}
                      onClick={() => set({ reasoningEffort: effort as ReasoningEffort })}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {has("seed") ? (
              <NumberControl
                label="Seed"
                onChange={(value) => set({ seed: value })}
                value={state.seed}
              />
            ) : null}
            {has("stop") ? (
              <TextControl
                label="Stop sequences"
                onChange={(value) => set({ stop: value })}
                placeholder="comma-separated"
                value={state.stop}
              />
            ) : null}
            {has("response_format") ? (
              <label className="flex cursor-pointer items-center justify-between text-[12px] text-muted">
                JSON response
                <input
                  checked={state.jsonMode}
                  className="accent-accent"
                  onChange={(event) => set({ jsonMode: event.target.checked })}
                  type="checkbox"
                />
              </label>
            ) : null}
            {has("tools") ? (
              <label className="block">
                <span className="block text-[12px] text-muted">Tools (JSON array)</span>
                <textarea
                  className="mt-1.5 min-h-[64px] w-full resize-y rounded-md border border-line-strong bg-surface px-2.5 py-1.5 font-mono text-[11px] text-ink outline-0 focus:border-[#bdbdbd]"
                  onChange={(event) => set({ toolsJson: event.target.value })}
                  placeholder='[{"type":"function","function":{...}}]'
                  spellCheck={false}
                  value={state.toolsJson}
                />
              </label>
            ) : null}
          </div>
        )}
      </section>

      {attachmentModalities.length > 0 ? (
        <section className="rounded-lg border border-line bg-surface p-3.5">
          <h2 className="mono-label m-0">Input</h2>
          <p className="mt-2 text-[12px] leading-5 text-ink-soft">
            This model accepts {attachmentModalities.join(" and ")} input. Attach files in the
            composer.
          </p>
          <p className="mt-1.5 text-[11px] leading-4 text-muted-2">
            Inline image and file serving over the gateway is still landing, attachments may not
            change the reply yet.
          </p>
        </section>
      ) : null}

      <section className="rounded-lg border border-line bg-surface p-3.5">
        <h2 className="mono-label m-0">Last response</h2>
        {lastUsage === null || entry === null ? (
          <p className="mt-2 text-[12px] leading-5 text-ink-faint">
            Send a message and the tokens, cost, and latency land here.
          </p>
        ) : (
          <dl className="m-0 mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px]">
            <dt className="text-muted">Tokens</dt>
            <dd className="m-0 text-right tabular-nums text-ink">
              {lastUsage.promptTokens !== null && lastUsage.completionTokens !== null
                ? `${lastUsage.promptTokens.toLocaleString("en-US")} in / ${lastUsage.completionTokens.toLocaleString("en-US")} out`
                : "not recorded"}
            </dd>
            <dt className="text-muted">Cost</dt>
            <dd className="m-0 text-right tabular-nums text-ink">
              {formatPerCallUsd(
                estimateResponseCostUsd(entry, lastUsage.promptTokens, lastUsage.completionTokens)
              )}
            </dd>
            <dt className="text-muted">Latency</dt>
            <dd className="m-0 text-right tabular-nums text-ink">
              {lastUsage.latencyMs.toLocaleString("en-US")} ms
            </dd>
          </dl>
        )}
      </section>
    </aside>
  );
}

function SliderControl({
  label,
  value,
  max,
  step,
  onChange,
  onReset
}: {
  label: string;
  value: number | null;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-[12px] text-muted">
        {label}
        <span className="font-mono text-[11px] text-ink">
          {value === null ? "model default" : value.toFixed(2)}
        </span>
      </span>
      <input
        aria-label={label}
        className="mt-1.5 w-full accent-accent"
        max={max}
        min={0}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="range"
        value={value ?? max / 2}
      />
      {value !== null ? (
        <button
          className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-[11px] text-muted-2 underline hover:text-muted"
          onClick={onReset}
          type="button"
        >
          Reset to model default
        </button>
      ) : null}
    </label>
  );
}

function NumberControl({
  label,
  value,
  onChange,
  hint
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-[12px] text-muted">
        {label}
        {hint !== undefined ? <span className="text-[11px] text-muted-2">{hint}</span> : null}
      </span>
      <input
        aria-label={label}
        className="mt-1.5 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-0 focus:border-[#bdbdbd]"
        inputMode="numeric"
        onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, ""))}
        placeholder="model default"
        value={value}
      />
    </label>
  );
}

function TextControl({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[12px] text-muted">{label}</span>
      <input
        aria-label={label}
        className="mt-1.5 w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-0 focus:border-[#bdbdbd]"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}

function EffortButton({
  label,
  active,
  onClick
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={clsx(
        "flex-1 cursor-pointer rounded-md border px-2 py-1 text-[11px] capitalize",
        active
          ? "border-accent/40 bg-accent-soft text-accent"
          : "border-line-strong text-ink-soft hover:bg-surface-subtle"
      )}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}
