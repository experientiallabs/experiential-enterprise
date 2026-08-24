// Small shared atoms for the catalog surfaces: provider badges, modality
// icons, supported-param chips, and the deployment status dot. All three
// pages (list, detail, compare) render these so the vocabulary looks
// identical everywhere; lib/models-catalog/format.ts owns the words.

import { AudioLines, FileText, Image as ImageIcon, Type, Video } from "lucide-react";
import { clsx } from "clsx";

import { Tooltip } from "@/components/ui/Tooltip";
import { paramChipLabel, providerDescription, providerLabel } from "@/lib/models-catalog/format";
import type { PromoChip } from "@/lib/models-catalog/promotions";

import { ProviderLogo } from "./model-icon";

/** Quiet outlined mono tag naming a provider route, led by its real brand logo. */
export function ProviderBadge({ provider, active }: { provider: string; active?: boolean }) {
  const description = providerDescription(provider);
  const badge = (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-px font-mono text-[10px] uppercase tracking-wide",
        active
          ? "border-accent/40 bg-accent-soft text-accent"
          : "border-line-strong text-ink-soft"
      )}
    >
      <ProviderLogo provider={provider} size={11} />
      {providerLabel(provider)}
    </span>
  );
  if (description === null) {
    return badge;
  }
  return (
    <Tooltip description={description} label={providerLabel(provider)}>
      {badge}
    </Tooltip>
  );
}

const MODALITY_ICONS = {
  text: Type,
  image: ImageIcon,
  audio: AudioLines,
  video: Video,
  pdf: FileText
} as const;

/** Compact icon strip for input modalities; the tooltip names them. */
export function ModalityIcons({ modalities }: { modalities: string[] }) {
  return (
    <Tooltip label={modalities.join(" · ")}>
      <span className="inline-flex items-center gap-1.5 text-ink-soft">
        {modalities.map((modality) => {
          const Icon = MODALITY_ICONS[modality as keyof typeof MODALITY_ICONS];
          if (!Icon) {
            return (
              <span className="font-mono text-[10px] uppercase" key={modality}>
                {modality}
              </span>
            );
          }
          return <Icon aria-label={modality} key={modality} size={13} strokeWidth={1.8} />;
        })}
      </span>
    </Tooltip>
  );
}

/** Supported-parameter chips (tools / reasoning / temp / ...). */
export function ParamChips({ params, limit }: { params: string[]; limit?: number }) {
  const shown = limit === undefined ? params : params.slice(0, limit);
  const hidden = params.length - shown.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((param) => (
        <span
          className="inline-flex items-center rounded-full bg-surface-subtle px-2 py-px font-mono text-[10px] text-ink-soft"
          key={param}
        >
          {paramChipLabel(param)}
        </span>
      ))}
      {hidden > 0 ? (
        <Tooltip label={params.slice(shown.length).map(paramChipLabel).join(" · ")}>
          <span className="font-mono text-[10px] text-muted-2">+{hidden}</span>
        </Tooltip>
      ) : null}
    </span>
  );
}

/**
 * The lane sentence a chip carries when the promo is lane-scoped. Rendered as
 * BOTH the hover title (pointer users) and the aria-label (assistive tech):
 * the visible copy stays bare by product decision, so the accessible name must
 * carry the eligibility restriction the pixels omit.
 */
function laneTitle(lead: string, providers: string[]): string | undefined {
  if (providers.length === 0) {
    return undefined;
  }
  return `${lead} when served via ${providers.map(providerLabel).join(", ")}`;
}

/**
 * "FREE" promo chip: this model is free up to a per-org allowance (an active
 * free promotion covers it). Accent-colored and compact, next to the name in
 * every catalog section the model appears in. Chip copy stays bare ("FREE");
 * a lane-scoped free tier explains its scope in the hover title instead.
 * Reached only through {@link PromoChipBadge} — the ranked chip is the one
 * public way to wear a free promo.
 */
function FreeChip({ providers }: { providers: string[] }) {
  return (
    <span
      aria-label={laneTitle("Free", providers)}
      className="inline-flex shrink-0 items-center rounded-full bg-accent-soft px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-accent"
      title={laneTitle("Free", providers)}
    >
      free
    </span>
  );
}

/**
 * Percent-discount promo chip. Copy is just "50% off" — the lane honesty for a
 * provider-scoped discount lives in the hover title ("50% off when served via
 * Experiential Cloud"), not in the visible text. Solid brand green so the deal
 * reads at a glance (the house solid-accent treatment: bg-accent + white, as
 * on the accent Button variant and the filter menu's selected state).
 */
export function PercentOffChip({ percent, providers }: { percent: number; providers: string[] }) {
  return (
    <span
      aria-label={laneTitle(`${percent}% off`, providers)}
      className="inline-flex shrink-0 items-center rounded-full bg-accent px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-white"
      title={laneTitle(`${percent}% off`, providers)}
    >
      {percent}% off
    </span>
  );
}

/**
 * One promotion chip, ranked: renders a slug's single winning chip from
 * lib/models-catalog/promotions.ts (free outranks percent). Shared by the
 * catalog table's rows and the admin promotions rows so both surfaces resolve
 * and paint promotions identically.
 */
export function PromoChipBadge({ chip }: { chip: PromoChip }) {
  if (chip.kind === "free") {
    return <FreeChip providers={chip.providers} />;
  }
  return <PercentOffChip percent={chip.percent_off} providers={chip.providers} />;
}

/** Deployment status as a quiet dot + word (active / degraded / disabled). */
export function StatusDot({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "bg-success"
      : status === "degraded"
        ? "bg-warning"
        : "bg-muted-2";
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-soft">
      <span aria-hidden className={clsx("h-1.5 w-1.5 rounded-full", tone)} />
      {status}
    </span>
  );
}
