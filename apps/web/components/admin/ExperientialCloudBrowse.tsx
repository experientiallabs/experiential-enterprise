"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dropdown } from "@/components/ui/Dropdown";
import { readApiError } from "@/components/world-models/wm-client";
import type {
  ExperientialCloudCreateInput,
  ExperientialCloudDeployment,
  ExperientialCloudUpdateInput
} from "@/lib/experiential-cloud/types";
import { formatPerMillionUsd } from "@/lib/money";

const INPUT_CLASS =
  "w-full min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";
const LABEL_CLASS =
  "mb-1.5 block text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/25";

/** One public catalog model an Experiential Cloud lane can attach to. */
export type ExperientialCloudModelOption = {
  slug: string;
  display_name: string;
};

type ExperientialCloudBrowseProps = {
  deployments: ExperientialCloudDeployment[];
  models: ExperientialCloudModelOption[];
  /** Whether THIS control process carries the worker's fallback origin (advisory). */
  workerBaseUrlConfigured: boolean;
};

/** Parse a micro-USD price field: blank -> undefined, else a non-negative int. */
function parseMicro(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function microString(value: number | null): string {
  return value === null ? "" : String(value);
}

/**
 * The admin Experiential Cloud browse: every EC serving lane (native vLLM on
 * Kion GPUs) as an editable row, plus a form to attach a lane to a public
 * model. A lane is one model_providers row; ON/OFF is its status (active vs
 * disabled). A new lane is created OFF so it is staged and never serves until
 * an operator flips it ON. The endpoint (base_url) is set per lane here; the
 * upstream bearer is a worker secret (EXPLABS_EXPERIENTIAL_CLOUD_API_KEY),
 * managed in deploy config and never stored in the catalog. Platform-admin
 * gated by the admin layout; mutations refresh the server list.
 */
export function ExperientialCloudBrowse({
  deployments,
  models,
  workerBaseUrlConfigured
}: ExperientialCloudBrowseProps) {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [providerModelId, setProviderModelId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [inputPrice, setInputPrice] = useState("");
  const [cachedPrice, setCachedPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [serveNow, setServeNow] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canSubmit = slug !== "" && providerModelId.trim() !== "";

  async function createLane(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || isCreating) {
      return;
    }
    setError(null);
    setNotice(null);
    setIsCreating(true);
    try {
      const body: ExperientialCloudCreateInput = {
        slug,
        provider_model_id: providerModelId.trim(),
        base_url: baseUrl.trim() === "" ? undefined : baseUrl.trim(),
        input_micro_usd_per_million: parseMicro(inputPrice),
        cached_input_micro_usd_per_million: parseMicro(cachedPrice),
        output_micro_usd_per_million: parseMicro(outputPrice),
        // Staged OFF by default; only an explicit choice serves at once.
        ...(serveNow ? { status: "active" as const } : {})
      };
      const response = await fetch("/api/admin/experiential-cloud", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to attach the lane."));
        return;
      }
      setNotice(
        serveNow
          ? `Experiential Cloud attached to "${slug}" and turned ON.`
          : `Experiential Cloud attached to "${slug}" (staged OFF).`
      );
      setSlug("");
      setProviderModelId("");
      setBaseUrl("");
      setInputPrice("");
      setCachedPrice("");
      setOutputPrice("");
      setServeNow(false);
      router.refresh();
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <form onSubmit={createLane} className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <label className={LABEL_CLASS} htmlFor="ec-slug">
                Model
              </label>
              <Dropdown
                id="ec-slug"
                className="w-full"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
              >
                <option value="">Select a public model...</option>
                {models.map((model) => (
                  <option key={model.slug} value={model.slug}>
                    {model.display_name} ({model.slug})
                  </option>
                ))}
              </Dropdown>
            </div>
            <div className="min-w-[200px] flex-1">
              <label className={LABEL_CLASS} htmlFor="ec-provider-model-id">
                Provider model id
              </label>
              <input
                id="ec-provider-model-id"
                className={INPUT_CLASS}
                type="text"
                placeholder="deepseek-v4-flash"
                value={providerModelId}
                onChange={(event) => setProviderModelId(event.target.value)}
              />
            </div>
          </div>

          <div>
            <label className={LABEL_CLASS} htmlFor="ec-base-url">
              Endpoint (base_url)
            </label>
            <input
              id="ec-base-url"
              className={`${INPUT_CLASS} max-w-[480px]`}
              type="text"
              placeholder="https://vllm.internal:8000/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <p className="m-0 mt-1.5 text-[12px] text-muted-2">
              The per-lane vLLM origin. Left blank, the lane uses the worker&apos;s{" "}
              <code>EXPLABS_EXPERIENTIAL_CLOUD_BASE_URL</code>. The upstream API key is a worker
              secret (<code>EXPLABS_EXPERIENTIAL_CLOUD_API_KEY</code>), set in deploy config and
              never stored here.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <PriceInput id="ec-input" label="Input" value={inputPrice} onChange={setInputPrice} />
            <PriceInput
              id="ec-cached"
              label="Cached input"
              value={cachedPrice}
              onChange={setCachedPrice}
            />
            <PriceInput
              id="ec-output"
              label="Output"
              value={outputPrice}
              onChange={setOutputPrice}
            />
            <label className="flex items-center gap-1.5 pb-2 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={serveNow}
                onChange={(event) => setServeNow(event.target.checked)}
              />
              Serve immediately (ON)
            </label>
            <Button disabled={!canSubmit || isCreating} type="submit" variant="primary">
              <Plus aria-hidden size={14} strokeWidth={2} />
              {isCreating ? "Attaching..." : "Attach Experiential Cloud"}
            </Button>
          </div>
          <p className="m-0 text-[12px] text-muted-2">
            Prices are micro-USD per million tokens (e.g. 42448 = $0.042/M). New lanes are staged
            OFF by default; flip them ON below at a moment&apos;s notice.
          </p>
        </form>
        {error && <p className="m-0 mt-3 text-[13px] text-danger">{error}</p>}
        {notice && <p className="m-0 mt-3 text-[13px] text-muted">{notice}</p>}
      </Card>

      {deployments.length === 0 ? (
        <Card>
          <p className="m-0 text-[13px] text-muted">
            No Experiential Cloud lanes yet. Experiential Cloud is off until you wire it: attach a
            lane above (it stays staged OFF and never serves), then flip it ON when the vLLM
            endpoint is ready.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {deployments.map((entry) => (
            <ExperientialCloudRow
              key={entry.deployment.id}
              entry={entry}
              workerBaseUrlConfigured={workerBaseUrlConfigured}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PriceInput({
  id,
  label,
  value,
  onChange
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="w-[150px]">
      <label className={LABEL_CLASS} htmlFor={id}>
        {label} (µ$/M)
      </label>
      <input
        id={id}
        className={INPUT_CLASS}
        type="number"
        min={0}
        step="1"
        placeholder="unknown"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="m-0 mt-1 text-[11px] text-muted-2">{formatPerMillionUsd(parseMicro(value) ?? null)}</p>
    </div>
  );
}

function ExperientialCloudRow({
  entry,
  workerBaseUrlConfigured
}: {
  entry: ExperientialCloudDeployment;
  workerBaseUrlConfigured: boolean;
}) {
  const router = useRouter();
  const { deployment } = entry;
  const isOn = deployment.status === "active";
  const [providerModelId, setProviderModelId] = useState(deployment.provider_model_id);
  const [baseUrl, setBaseUrl] = useState(deployment.base_url ?? "");
  const [inputPrice, setInputPrice] = useState(microString(deployment.input_micro_usd_per_million));
  const [cachedPrice, setCachedPrice] = useState(
    microString(deployment.cached_input_micro_usd_per_million)
  );
  const [outputPrice, setOutputPrice] = useState(
    microString(deployment.output_micro_usd_per_million)
  );
  const [busy, setBusy] = useState<"save" | "toggle" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingOn, setConfirmingOn] = useState(false);

  // A lane that is ON but resolves no origin (no per-row base_url and no worker
  // fallback in this process) is skipped by the catalog builder: it counts as
  // ON but never serves. Warn so the operator wires the endpoint.
  const unroutableWhileOn =
    isOn && deployment.base_url === null && !workerBaseUrlConfigured;

  async function save() {
    setError(null);
    setBusy("save");
    try {
      const body: ExperientialCloudUpdateInput = {
        provider_model_id: providerModelId.trim(),
        base_url: baseUrl.trim() === "" ? undefined : baseUrl.trim(),
        input_micro_usd_per_million: parseMicro(inputPrice),
        cached_input_micro_usd_per_million: parseMicro(cachedPrice),
        output_micro_usd_per_million: parseMicro(outputPrice),
        // The form does not expose the reasoning-token rate; carry the existing
        // value through so a full-resource PATCH never silently zeroes it.
        reasoning_micro_usd_per_million: deployment.reasoning_micro_usd_per_million ?? undefined
      };
      const response = await fetch(
        `/api/admin/experiential-cloud/${encodeURIComponent(deployment.id)}`,
        { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "PATCH" }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to save the lane."));
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(status: "active" | "disabled") {
    setError(null);
    setBusy("toggle");
    try {
      const response = await fetch(
        `/api/admin/experiential-cloud/${encodeURIComponent(deployment.id)}/status`,
        { body: JSON.stringify({ status }), headers: { "content-type": "application/json" }, method: "POST" }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to change the lane state."));
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
      setConfirmingOn(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold text-ink">{entry.display_name}</span>
        <span className="font-mono text-[12px] text-muted-2">{entry.slug}</span>
        <span
          className={`ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
            isOn ? "bg-success/15 text-success" : "bg-surface-subtle text-muted"
          }`}
        >
          {isOn ? "ON (serving)" : "OFF (staged)"}
        </span>
      </div>
      {unroutableWhileOn ? (
        <p className="m-0 mt-2 text-[12.5px] text-danger">
          This lane is ON but has no endpoint and no worker origin is configured, so it is not
          serving. Set the endpoint (base_url) below.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-1">
          <label className={LABEL_CLASS} htmlFor={`pmi-${deployment.id}`}>
            Provider model id
          </label>
          <input
            id={`pmi-${deployment.id}`}
            className={INPUT_CLASS}
            type="text"
            value={providerModelId}
            onChange={(event) => setProviderModelId(event.target.value)}
          />
        </div>
        <div className="min-w-[240px] flex-[2]">
          <label className={LABEL_CLASS} htmlFor={`url-${deployment.id}`}>
            Endpoint (base_url)
          </label>
          <input
            id={`url-${deployment.id}`}
            className={INPUT_CLASS}
            type="text"
            placeholder="worker default"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <PriceInput
          id={`in-${deployment.id}`}
          label="Input"
          value={inputPrice}
          onChange={setInputPrice}
        />
        <PriceInput
          id={`ca-${deployment.id}`}
          label="Cached input"
          value={cachedPrice}
          onChange={setCachedPrice}
        />
        <PriceInput
          id={`out-${deployment.id}`}
          label="Output"
          value={outputPrice}
          onChange={setOutputPrice}
        />
        <Button disabled={busy !== null} onClick={save} type="button" variant="primary">
          {busy === "save" ? "Saving..." : "Save"}
        </Button>
        {isOn ? (
          <Button
            disabled={busy !== null}
            onClick={() => void setStatus("disabled")}
            type="button"
            variant="ghost"
          >
            {busy === "toggle" ? "Turning off..." : "Turn OFF"}
          </Button>
        ) : (
          <Button
            disabled={busy !== null}
            onClick={() => setConfirmingOn(true)}
            type="button"
            variant="primary"
          >
            Turn ON
          </Button>
        )}
      </div>
      {error && <p className="m-0 mt-3 text-[13px] text-danger">{error}</p>}

      <ConfirmDialog
        open={confirmingOn}
        title={`Turn ON Experiential Cloud for "${entry.slug}"?`}
        body="Turning this lane ON routes real customer traffic to it as soon as its endpoint resolves. Make sure the vLLM endpoint and worker key are ready."
        confirmLabel="Turn ON"
        busyLabel="Turning on..."
        busy={busy === "toggle"}
        tone="warning"
        onCancel={() => setConfirmingOn(false)}
        onConfirm={() => void setStatus("active")}
      />
    </Card>
  );
}
