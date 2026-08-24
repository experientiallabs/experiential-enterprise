"use client";

// "Add a local model": register a customer's own OpenAI-compatible endpoint (a
// self-hosted vLLM box, a lab server) as a model they can call through the
// gateway. int-p3's serving contract is that a local route only serves as its
// OWN org-owned model (owning_org_id = the org), never as a variant row on a
// public/shared model — the tenant guard blocks the latter from routing. So
// this creates an org-owned model (a namespaced, non-leading-digit slug that
// can't collide with a global gateway alias) plus its `local` provider row and
// default chain, via store.createLocalModel. The model is private to the org
// and callable within one 15s builder poll tick. Auth gates the ACTION only —
// signed-out visitors see the button and get the login modal.

import { useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { createLocalModel } from "@/components/keys/store";
import { Button } from "@/components/ui/Button";
import { modelPath } from "@/lib/routes";

type LocalVariantFormProps = {
  /** The public model this local endpoint stands in for; seeds the org slug. */
  slug: string;
  /** The public model's display name; the org model is named "<name> (local)". */
  displayName: string;
  /** Null renders the signed-out state (button opens the login modal). */
  orgId: string | null;
  /**
   * Start expanded to the form fields rather than the collapsed button. The
   * "Add a way" chooser sets this so picking "Add a local model" lands on the
   * fields directly; standalone mounts keep the collapsed default.
   */
  defaultOpen?: boolean;
};

/**
 * The org-owned model's slug: namespaced by public model + org so two orgs
 * adding a local endpoint for the same model never collide on the globally
 * unique gateway alias name. Forced to the gateway slug grammar
 * (^[a-z0-9][a-z0-9._-]{0,127}$) with a non-digit lead — WMO's ArtifactId
 * rejects a leading digit.
 */
export function orgLocalSlug(publicSlug: string, orgId: string): string {
  const base = `${publicSlug}-local-${orgId.slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return (/^[a-z]/.test(base) ? base : `m-${base}`).slice(0, 128);
}

export function LocalVariantForm({ slug, displayName, orgId, defaultOpen = false }: LocalVariantFormProps) {
  const { open: openLogin, requireAuth } = useLoginModal();
  const [openForm, setOpenForm] = useState(defaultOpen);
  const [baseUrl, setBaseUrl] = useState("");
  const [providerModelId, setProviderModelId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const onOpen = () => {
    if (orgId === null) {
      openLogin();
      return;
    }
    requireAuth(() => setOpenForm(true));
  };

  const submit = async () => {
    if (orgId === null) {
      openLogin();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await createLocalModel(orgId, {
        slug: orgLocalSlug(slug, orgId),
        displayName: `${displayName} (local)`,
        baseUrl: baseUrl.trim(),
        providerModelId: providerModelId.trim()
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setCreated(result.model.model.slug);
      setOpenForm(false);
      setBaseUrl("");
      setProviderModelId("");
    } finally {
      setSubmitting(false);
    }
  };

  if (!openForm) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Button onClick={onOpen} size="sm" type="button">
            <Plus aria-hidden size={13} strokeWidth={1.8} />
            Add a local model
          </Button>
        </div>
        {created !== null ? (
          <p className="m-0 text-[12.5px] text-success">
            Created <span className="font-mono text-[11.5px]">{created}</span> — a model private to
            your organization.{" "}
            <Link className="font-semibold text-accent underline" href={modelPath(created)}>
              View model
            </Link>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface-subtle/60 p-4"
      data-testid="local-variant-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="mono-label m-0">New local model</p>
      <p className="m-0 max-w-[780px] text-[12.5px] leading-relaxed text-muted">
        An OpenAI-compatible endpoint your organization runs. This creates a model private to your
        org — callable through the same gateway with identical telemetry — served from your
        endpoint. It appears as its own model, not a route on this public model.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-soft">
          Base URL
          <input
            className="min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 font-mono text-[12.5px] font-normal text-ink placeholder:text-muted-2 focus:border-accent focus:outline-none"
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://your-host:8000/v1"
            required
            type="url"
            value={baseUrl}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-soft">
          Served model id
          <input
            className="min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 font-mono text-[12.5px] font-normal text-ink placeholder:text-muted-2 focus:border-accent focus:outline-none"
            onChange={(event) => setProviderModelId(event.target.value)}
            placeholder="the model name your server expects"
            required
            value={providerModelId}
          />
        </label>
      </div>
      {error !== null ? <p className="m-0 text-[12.5px] text-danger">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button loading={submitting} size="sm" type="submit" variant="primary">
          Create local model
        </Button>
        <Button
          disabled={submitting}
          onClick={() => setOpenForm(false)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
