"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dropdown } from "@/components/ui/Dropdown";
import { PromoChipBadge } from "@/components/models-catalog/badges";
import {
  KNOWN_ORG_LABEL_KEYS,
  OrgLabelBadge,
  orgLabelDisplay
} from "@/lib/admin/org-labels";
import { rankPromosForSlug } from "@/lib/models-catalog/promotions";
import { readApiError } from "@/components/world-models/wm-client";
import { FAMILY_LABELS } from "@/lib/models-catalog/families";
import { PROVIDER_LABELS } from "@/lib/models-catalog/format";
import { FUNDING_SCOPE_OPTIONS } from "@/lib/promotions/types";
import type {
  ModelPromotion,
  ModelPromotionCreateInput,
  PromotionCapScope,
  PromotionFundingScope,
} from "@/lib/promotions/types";

const INPUT_CLASS =
  "w-full min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";
const LABEL_CLASS =
  "mb-1.5 block text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/25";
const CHECK_CLASS = "flex cursor-pointer items-center gap-1.5 text-[12.5px] text-ink";
const CHIP_CLASS =
  "inline-flex items-center gap-1 rounded-full bg-surface-subtle px-2 py-px font-mono text-[11px] text-ink-soft";
const ROW_ACTION_CLASS =
  "cursor-pointer rounded-sm p-1 text-muted transition-colors hover:bg-surface-subtle hover:text-ink";

const MICRO_PER_USD = 1_000_000;

function capToDollars(microUsd: number): number {
  return microUsd / MICRO_PER_USD;
}

function dollarsToMicro(dollars: number): number {
  return Math.round(dollars * MICRO_PER_USD);
}

/** The one-line money summary a collapsed row wears: "$10 free · 50% off to $5 · monthly". */
function termsSummary(promotion: ModelPromotion): string {
  const parts: string[] = [];
  if (promotion.per_org_cap_micro_usd > 0) {
    parts.push(`$${capToDollars(promotion.per_org_cap_micro_usd)} free`);
  }
  if (promotion.percent_off > 0) {
    parts.push(
      `${promotion.percent_off}% off${
        promotion.discount_cap_micro_usd > 0
          ? ` to $${capToDollars(promotion.discount_cap_micro_usd)}`
          : ""
      }`
    );
  }
  parts.push(promotion.cap_scope === "recurring" ? "monthly" : "lifetime");
  // Only surface a non-default lane; platform-funded is the norm.
  if (promotion.funding_scope === "all") {
    parts.push("all traffic");
  } else if (promotion.funding_scope === "byok") {
    parts.push("BYOK only");
  }
  return parts.join(" · ");
}

/** One public catalog model the panel can target (family key pre-derived). */
export type PromotionModelOption = {
  slug: string;
  display_name: string;
  familyKey: string;
};

type PromotionsBrowseProps = {
  promotions: ModelPromotion[];
  /** The public catalog: the family-expansion source and slug validator. */
  models: PromotionModelOption[];
};

/**
 * The admin Promotions browse: one card of compact promotion rows (each
 * expandable in place to the full editor) plus a create form folded behind
 * the New promotion button. A scope targets provider lanes (checkboxes),
 * families (which expand client-side to the matching catalog slugs), and
 * individual slugs; the submitted model_slugs is the deduped, sorted union.
 * Money terms are edited in dollars and sent in micro-USD. Platform-admin
 * gated by the admin layout above; the gateway enforces these terms.
 * Mutations refresh the server list.
 */
export function PromotionsBrowse({ promotions, models }: PromotionsBrowseProps) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [selectedFamilies, setSelectedFamilies] = useState<string[]>([]);
  const [selectedAudience, setSelectedAudience] = useState<string[]>([]);
  const [manualSlugs, setManualSlugs] = useState<string[]>([]);
  const [excludedSlugs, setExcludedSlugs] = useState<string[]>([]);
  const [slugInput, setSlugInput] = useState("");
  const [slugError, setSlugError] = useState<string | null>(null);
  const [capUsd, setCapUsd] = useState("10");
  const [discountCapUsd, setDiscountCapUsd] = useState("0");
  const [percentOff, setPercentOff] = useState("0");
  const [capScope, setCapScope] = useState<PromotionCapScope>("lifetime");
  const [fundingScope, setFundingScope] = useState<PromotionFundingScope>("platform_funded");
  const [displayOrder, setDisplayOrder] = useState("0");
  const [active, setActive] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Only families that actually have catalog models are offered: an empty
  // family expands to nothing and cannot scope a promotion.
  const familyOptions = useMemo(() => {
    const present = new Set(models.map((model) => model.familyKey));
    return Object.entries(FAMILY_LABELS).filter(([key]) => present.has(key));
  }, [models]);

  const knownSlugs = useMemo(() => new Set(models.map((model) => model.slug)), [models]);

  // The effective slug set: family expansions plus manual adds, minus chips the
  // admin removed, deduped and sorted — exactly what the create submits.
  const effectiveSlugs = useMemo(() => {
    const expanded = models
      .filter((model) => selectedFamilies.includes(model.familyKey))
      .map((model) => model.slug);
    const union = new Set([...expanded, ...manualSlugs]);
    for (const slug of excludedSlugs) {
      union.delete(slug);
    }
    return [...union].sort();
  }, [models, selectedFamilies, manualSlugs, excludedSlugs]);

  const canSubmit =
    label.trim() !== "" && (effectiveSlugs.length > 0 || selectedProviders.length > 0);

  function toggle(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  function addManualSlug() {
    const slug = slugInput.trim();
    if (slug === "") {
      return;
    }
    if (!knownSlugs.has(slug)) {
      setSlugError(`"${slug}" is not a catalog model slug.`);
      return;
    }
    setSlugError(null);
    setSlugInput("");
    setExcludedSlugs((current) => current.filter((item) => item !== slug));
    setManualSlugs((current) => (current.includes(slug) ? current : [...current, slug]));
  }

  function removeSlugChip(slug: string) {
    if (manualSlugs.includes(slug)) {
      setManualSlugs((current) => current.filter((item) => item !== slug));
      return;
    }
    setExcludedSlugs((current) => (current.includes(slug) ? current : [...current, slug]));
  }

  // Folding the form must also drop its draft: a canceled draft reappearing
  // on the next New promotion is a stale-submit hazard.
  function resetCreateForm() {
    setCreating(false);
    setLabel("");
    setSelectedProviders([]);
    setSelectedFamilies([]);
    setSelectedAudience([]);
    setManualSlugs([]);
    setExcludedSlugs([]);
    setSlugInput("");
    setSlugError(null);
    setCapUsd("10");
    setDiscountCapUsd("0");
    setPercentOff("0");
    setCapScope("lifetime");
    setFundingScope("platform_funded");
    setDisplayOrder("0");
    setActive(true);
    setError(null);
  }

  async function createPromotion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || isCreating) {
      return;
    }
    setError(null);
    setNotice(null);
    setIsCreating(true);
    try {
      const body: ModelPromotionCreateInput = {
        label: label.trim(),
        model_slugs: effectiveSlugs,
        family_keys: [...selectedFamilies].sort(),
        providers: [...selectedProviders].sort(),
        audience_labels: [...selectedAudience].sort(),
        funding_scope: fundingScope,
        per_org_cap_micro_usd: dollarsToMicro(Number(capUsd) || 0),
        discount_cap_micro_usd: dollarsToMicro(Number(discountCapUsd) || 0),
        cap_scope: capScope,
        percent_off: Number(percentOff) || 0,
        active,
        display_order: Number(displayOrder) || 0,
      };
      const response = await fetch("/api/admin/model-promotions", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to add the promotion."));
        return;
      }
      setNotice(`Promotion "${label.trim()}" added.`);
      resetCreateForm();
      router.refresh();
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {promotions.length === 0 ? (
        <Card>
          <p className="m-0 text-[13px] text-muted">No promotions yet.</p>
        </Card>
      ) : (
        <Card>
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {promotions.map((promotion) => (
              <PromotionRow key={promotion.id} promotion={promotion} />
            ))}
          </ul>
        </Card>
      )}

      {!creating ? (
        <div>
          <Button onClick={() => setCreating(true)} type="button" variant="ghost">
            <Plus aria-hidden size={14} strokeWidth={2} />
            New promotion
          </Button>
        </div>
      ) : (
        <Card>
          <form onSubmit={createPromotion} className="flex flex-col gap-4">
            <div className="max-w-[420px]">
              <label className={LABEL_CLASS} htmlFor="promo-label">
                Label
              </label>
              <input
                id="promo-label"
                className={INPUT_CLASS}
                type="text"
                required
                placeholder="Launch week: Qwen free tier"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>

            <fieldset className="m-0 border-0 p-0">
              <legend className={LABEL_CLASS}>Providers (empty = any provider)</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {Object.entries(PROVIDER_LABELS).map(([key, providerName]) => (
                  <label className={CHECK_CLASS} key={key}>
                    <input
                      checked={selectedProviders.includes(key)}
                      onChange={() => setSelectedProviders((current) => toggle(current, key))}
                      type="checkbox"
                    />
                    {providerName}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="m-0 border-0 p-0">
              <legend className={LABEL_CLASS}>Families (expand to their catalog models)</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {familyOptions.map(([key, familyName]) => (
                  <label className={CHECK_CLASS} key={key}>
                    <input
                      checked={selectedFamilies.includes(key)}
                      onChange={() => setSelectedFamilies((current) => toggle(current, key))}
                      type="checkbox"
                    />
                    {familyName}
                  </label>
                ))}
              </div>
            </fieldset>

            <AudienceControl
              idPrefix="create"
              value={selectedAudience}
              onChange={setSelectedAudience}
            />

            <div>
              <label className={LABEL_CLASS} htmlFor="promo-slug">
                Add a model by slug
              </label>
              <div className="flex max-w-[420px] items-center gap-2">
                <input
                  id="promo-slug"
                  className={INPUT_CLASS}
                  type="text"
                  placeholder="qwen3.8-27b"
                  value={slugInput}
                  onChange={(event) => {
                    setSlugInput(event.target.value);
                    setSlugError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addManualSlug();
                    }
                  }}
                />
                <Button onClick={addManualSlug} type="button" variant="ghost">
                  Add
                </Button>
              </div>
              {slugError && <p className="m-0 mt-1.5 text-[12.5px] text-danger">{slugError}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {effectiveSlugs.map((slug) => (
                  <span className={CHIP_CLASS} key={slug}>
                    {slug}
                    <button
                      aria-label={`Remove ${slug}`}
                      className="cursor-pointer text-muted-2 hover:text-ink"
                      onClick={() => removeSlugChip(slug)}
                      type="button"
                    >
                      <X aria-hidden size={11} strokeWidth={2} />
                    </button>
                  </span>
                ))}
                {effectiveSlugs.length === 0 && selectedProviders.length > 0 ? (
                  <p className="m-0 text-[12.5px] text-muted">
                    No models selected. Applies to all models served via the selected providers.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="w-[120px]">
                <label className={LABEL_CLASS} htmlFor="promo-cap">
                  Free cap (USD)
                </label>
                <input
                  id="promo-cap"
                  className={INPUT_CLASS}
                  type="number"
                  min={0}
                  step="0.01"
                  value={capUsd}
                  onChange={(event) => setCapUsd(event.target.value)}
                />
              </div>
              <div className="w-[150px]">
                <label
                  className={LABEL_CLASS}
                  htmlFor="promo-discount-cap"
                  title="Per-organization charged-spend ceiling for the % discount. $0 = uncapped."
                >
                  Discount cap (USD)
                </label>
                <input
                  id="promo-discount-cap"
                  className={INPUT_CLASS}
                  type="number"
                  min={0}
                  step="0.01"
                  value={discountCapUsd}
                  onChange={(event) => setDiscountCapUsd(event.target.value)}
                />
              </div>
              <div className="w-[110px]">
                <label className={LABEL_CLASS} htmlFor="promo-percent">
                  % off
                </label>
                <input
                  id="promo-percent"
                  className={INPUT_CLASS}
                  type="number"
                  min={0}
                  max={100}
                  step="1"
                  value={percentOff}
                  onChange={(event) => setPercentOff(event.target.value)}
                />
              </div>
              <div className="w-[130px]">
                <label className={LABEL_CLASS} htmlFor="promo-scope">
                  Cap resets
                </label>
                <Dropdown
                  id="promo-scope"
                  className="w-full"
                  value={capScope}
                  onChange={(event) => setCapScope(event.target.value as PromotionCapScope)}
                >
                  <option value="lifetime">Never (lifetime)</option>
                  <option value="recurring">Monthly</option>
                </Dropdown>
              </div>
              <div className="w-[170px]">
                <label className={LABEL_CLASS} htmlFor="promo-funding">
                  Funding
                </label>
                <Dropdown
                  id="promo-funding"
                  className="w-full"
                  title="Which money lane the promo applies to. BYOK traffic carries no platform charge, so a BYOK-scoped promo is inert until BYOK is billed."
                  value={fundingScope}
                  onChange={(event) =>
                    setFundingScope(event.target.value as PromotionFundingScope)
                  }
                >
                  {FUNDING_SCOPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Dropdown>
              </div>
              <div className="w-[90px]">
                <label className={LABEL_CLASS} htmlFor="promo-order">
                  Order
                </label>
                <input
                  id="promo-order"
                  className={INPUT_CLASS}
                  type="number"
                  step="1"
                  value={displayOrder}
                  onChange={(event) => setDisplayOrder(event.target.value)}
                />
              </div>
              <label className="flex items-center gap-1.5 pb-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(event) => setActive(event.target.checked)}
                />
                Active
              </label>
              <Button disabled={!canSubmit || isCreating} type="submit" variant="primary">
                <Plus aria-hidden size={14} strokeWidth={2} />
                {isCreating ? "Adding..." : "Add promotion"}
              </Button>
              <Button onClick={resetCreateForm} type="button" variant="ghost">
                Cancel
              </Button>
            </div>
          </form>
          {error && <p className="m-0 mt-3 text-[13px] text-danger">{error}</p>}
        </Card>
      )}
      {notice && <p className="m-0 text-[13px] text-muted">{notice}</p>}
    </div>
  );
}

/**
 * The "Limit to account types" control: a house Dropdown to pick a known org
 * label kind, an Add action that appends it, and removable chips for the
 * selected set. Empty = the promotion applies to every account.
 */
function AudienceControl({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [pick, setPick] = useState("");
  const addable = KNOWN_ORG_LABEL_KEYS.filter((key) => !value.includes(key));
  return (
    <div>
      <label className={LABEL_CLASS} htmlFor={`${idPrefix}-audience`}>
        Limit to account types (empty = all accounts)
      </label>
      <div className="flex max-w-[420px] items-center gap-2">
        <Dropdown
          id={`${idPrefix}-audience`}
          className="w-full"
          value={pick}
          disabled={addable.length === 0}
          onChange={(event) => setPick(event.target.value)}
        >
          <option value="">
            {addable.length === 0 ? "All known labels added" : "Select an account type..."}
          </option>
          {addable.map((key) => (
            <option key={key} value={key}>
              {orgLabelDisplay(key).label}
            </option>
          ))}
        </Dropdown>
        <Button
          disabled={pick === ""}
          onClick={() => {
            if (pick !== "" && !value.includes(pick)) {
              onChange([...value, pick]);
            }
            setPick("");
          }}
          type="button"
          variant="ghost"
        >
          Add account type
        </Button>
      </div>
      {value.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {value.map((key) => (
            <span className="inline-flex items-center gap-1" key={key}>
              <OrgLabelBadge labelKey={key} />
              <button
                aria-label={`Remove ${orgLabelDisplay(key).label}`}
                className="cursor-pointer text-muted-2 hover:text-ink"
                onClick={() => onChange(value.filter((item) => item !== key))}
                type="button"
              >
                <X aria-hidden size={11} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PromotionRow({ promotion }: { promotion: ModelPromotion }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(promotion.label);
  const [capUsd, setCapUsd] = useState(String(capToDollars(promotion.per_org_cap_micro_usd)));
  const [discountCapUsd, setDiscountCapUsd] = useState(
    String(capToDollars(promotion.discount_cap_micro_usd))
  );
  const [percentOff, setPercentOff] = useState(String(promotion.percent_off));
  const [capScope, setCapScope] = useState<PromotionCapScope>(promotion.cap_scope);
  const [fundingScope, setFundingScope] = useState<PromotionFundingScope>(
    promotion.funding_scope
  );
  const [audience, setAudience] = useState<string[]>(promotion.audience_labels);
  const [active, setActive] = useState(promotion.active);
  const [displayOrder, setDisplayOrder] = useState(String(promotion.display_order));
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  async function save() {
    setError(null);
    setBusy("save");
    try {
      // PUT is full-resource: the targeting arrays ride along unchanged (the
      // row edits terms in place; retargeting means recreating the promotion).
      const body: ModelPromotionCreateInput = {
        label: label.trim(),
        model_slugs: promotion.model_slugs,
        family_keys: promotion.family_keys,
        providers: promotion.providers,
        audience_labels: audience,
        funding_scope: fundingScope,
        per_org_cap_micro_usd: dollarsToMicro(Number(capUsd) || 0),
        discount_cap_micro_usd: dollarsToMicro(Number(discountCapUsd) || 0),
        cap_scope: capScope,
        percent_off: Number(percentOff) || 0,
        active,
        display_order: Number(displayOrder) || 0,
      };
      const response = await fetch(
        `/api/admin/model-promotions/${encodeURIComponent(promotion.id)}`,
        {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "PUT",
        }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to save the promotion."));
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setError(null);
    setBusy("remove");
    try {
      const response = await fetch(
        `/api/admin/model-promotions/${encodeURIComponent(promotion.id)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        setError(await readApiError(response, "Unable to remove the promotion."));
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
      setConfirmingRemove(false);
    }
  }

  // The row wears the promo's single RANKED chip, resolved through the same
  // helper as the storefront (free outranks percent), so the admin never sees
  // a chip combination a customer cannot. Both terms stay editable below.
  const chip = rankPromosForSlug([
    {
      label: promotion.label,
      slugs: promotion.model_slugs,
      display_order: promotion.display_order,
      free: promotion.per_org_cap_micro_usd > 0,
      percent_off: promotion.percent_off,
      providers: promotion.providers,
      family_keys: promotion.family_keys,
    },
  ]);

  return (
    <li className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[13px] font-medium text-ink">{promotion.label}</span>
        {chip !== null ? <PromoChipBadge chip={chip} /> : null}
        {!promotion.active ? <span className={CHIP_CLASS}>inactive</span> : null}
        {promotion.audience_labels.length === 0 ? (
          <span className="text-[12.5px] text-muted-2">All accounts</span>
        ) : (
          promotion.audience_labels.map((key) => <OrgLabelBadge key={key} labelKey={key} />)
        )}
        {promotion.providers.map((provider) => (
          <span className={CHIP_CLASS} key={provider}>
            {PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider}
          </span>
        ))}
        {promotion.family_keys.map((key) => (
          <span className={CHIP_CLASS} key={key}>
            {FAMILY_LABELS[key] ?? key}
          </span>
        ))}
        {promotion.model_slugs.length === 0 ? (
          <span className="text-[12.5px] text-muted">All models via the selected providers</span>
        ) : (
          <details className="text-[12.5px] text-muted">
            <summary className="cursor-pointer select-none">
              {promotion.model_slugs.length}{" "}
              {promotion.model_slugs.length === 1 ? "model" : "models"}
            </summary>
            <span className="mt-1 flex flex-wrap gap-1.5">
              {promotion.model_slugs.map((slug) => (
                <span className={CHIP_CLASS} key={slug}>
                  {slug}
                </span>
              ))}
            </span>
          </details>
        )}
        <span className="ml-auto inline-flex items-center gap-2">
          <span className="font-mono text-[11.5px] text-muted-2">
            {termsSummary(promotion)}
          </span>
          <button
            aria-label={`Edit ${promotion.label}`}
            className={ROW_ACTION_CLASS}
            onClick={() => setEditing((current) => !current)}
            type="button"
          >
            <Pencil aria-hidden size={13} strokeWidth={1.8} />
          </button>
          <button
            aria-label={`Remove ${promotion.label}`}
            className="cursor-pointer rounded-sm p-1 text-muted transition-colors hover:bg-surface-subtle hover:text-danger"
            disabled={busy !== null}
            onClick={() => setConfirmingRemove(true)}
            type="button"
          >
            <Trash2 aria-hidden size={13} strokeWidth={1.8} />
          </button>
        </span>
      </div>

      {editing ? (
        <div className="rounded-lg border border-line bg-surface-subtle/40 p-3">
          <AudienceControl idPrefix={promotion.id} value={audience} onChange={setAudience} />
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-[160px] flex-1">
              <label className={LABEL_CLASS} htmlFor={`label-${promotion.id}`}>
                Label
              </label>
              <input
                id={`label-${promotion.id}`}
                className={INPUT_CLASS}
                type="text"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="w-[120px]">
              <label className={LABEL_CLASS} htmlFor={`cap-${promotion.id}`}>
                Free cap (USD)
              </label>
              <input
                id={`cap-${promotion.id}`}
                className={INPUT_CLASS}
                type="number"
                min={0}
                step="0.01"
                value={capUsd}
                onChange={(event) => setCapUsd(event.target.value)}
              />
            </div>
            <div className="w-[150px]">
              <label
                className={LABEL_CLASS}
                htmlFor={`discount-cap-${promotion.id}`}
                title="Per-organization charged-spend ceiling for the % discount. $0 = uncapped."
              >
                Discount cap (USD)
              </label>
              <input
                id={`discount-cap-${promotion.id}`}
                className={INPUT_CLASS}
                type="number"
                min={0}
                step="0.01"
                value={discountCapUsd}
                onChange={(event) => setDiscountCapUsd(event.target.value)}
              />
            </div>
            <div className="w-[100px]">
              <label className={LABEL_CLASS} htmlFor={`pct-${promotion.id}`}>
                % off
              </label>
              <input
                id={`pct-${promotion.id}`}
                className={INPUT_CLASS}
                type="number"
                min={0}
                max={100}
                step="1"
                value={percentOff}
                onChange={(event) => setPercentOff(event.target.value)}
              />
            </div>
            <div className="w-[130px]">
              <label className={LABEL_CLASS} htmlFor={`scope-${promotion.id}`}>
                Cap resets
              </label>
              <Dropdown
                id={`scope-${promotion.id}`}
                className="w-full"
                value={capScope}
                onChange={(event) => setCapScope(event.target.value as PromotionCapScope)}
              >
                <option value="lifetime">Never (lifetime)</option>
                <option value="recurring">Monthly</option>
              </Dropdown>
            </div>
            <div className="w-[170px]">
              <label className={LABEL_CLASS} htmlFor={`funding-${promotion.id}`}>
                Funding
              </label>
              <Dropdown
                id={`funding-${promotion.id}`}
                className="w-full"
                title="Which money lane the promo applies to. BYOK traffic carries no platform charge, so a BYOK-scoped promo is inert until BYOK is billed."
                value={fundingScope}
                onChange={(event) => setFundingScope(event.target.value as PromotionFundingScope)}
              >
                {FUNDING_SCOPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Dropdown>
            </div>
            <div className="w-[90px]">
              <label className={LABEL_CLASS} htmlFor={`order-${promotion.id}`}>
                Order
              </label>
              <input
                id={`order-${promotion.id}`}
                className={INPUT_CLASS}
                type="number"
                step="1"
                value={displayOrder}
                onChange={(event) => setDisplayOrder(event.target.value)}
              />
            </div>
            <label className="flex items-center gap-1.5 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={active}
                onChange={(event) => setActive(event.target.checked)}
              />
              Active
            </label>
            <Button disabled={busy !== null} onClick={save} type="button" variant="primary">
              {busy === "save" ? "Saving..." : "Save"}
            </Button>
          </div>
          {error && <p className="m-0 mt-3 text-[13px] text-danger">{error}</p>}
        </div>
      ) : null}
      {!editing && error ? <p className="m-0 text-[13px] text-danger">{error}</p> : null}

      <ConfirmDialog
        open={confirmingRemove}
        title={`Remove the promotion "${promotion.label}"?`}
        body="This cannot be undone."
        confirmLabel="Remove promotion"
        busyLabel="Removing..."
        busy={busy === "remove"}
        tone="danger"
        confirmVariant="destructive"
        onCancel={() => setConfirmingRemove(false)}
        onConfirm={() => void remove()}
      />
    </li>
  );
}
