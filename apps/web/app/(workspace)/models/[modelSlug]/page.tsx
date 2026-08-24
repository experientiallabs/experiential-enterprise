import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Columns2, SquareTerminal } from "lucide-react";

import { ModalityIcons } from "@/components/models-catalog/badges";
import { ModelIcon } from "@/components/models-catalog/model-icon";
import { modelIconKey } from "@/lib/models-catalog/families";
import { RecommendedStar } from "@/components/models-catalog/recommended-star";
import { BenchmarksCard } from "@/components/models-catalog/detail/benchmarks-card";
import { ProvidersTable } from "@/components/models-catalog/detail/providers-table";
import { QuickstartCard } from "@/components/models-catalog/detail/quickstart-card";
import { WaysToUse } from "@/components/models-catalog/detail/ways-to-use";
import { buttonClassName } from "@/components/ui/Button";
import { publicServingBaseUrl } from "@/components/world-models/endpoint-snippets";
import { resolveActiveOrg } from "@/lib/active-org";
import { isPlatformAdmin } from "@/lib/auth/admin";
import { isOrgAdmin } from "@/lib/auth/admin-orgs";
import { getAuthenticatedUser } from "@/lib/auth/server";
import {
  cheapestInputMicro,
  cheapestOutputMicro,
  formatReleaseDate,
  formatTokenCount
} from "@/lib/models-catalog/format";
import { PLATFORM_WEB_URL } from "@/lib/llms-txt";
import { fetchModelDetail } from "@/lib/models-catalog/server";
import { servedThroughExperiential } from "@/lib/models-catalog/serving";
import { formatPerMillionUsd } from "@/lib/money";
import { isReservedRouteSlug, modelsPath, playgroundPath, reservedSlugRedirect } from "@/lib/routes";

export const metadata = { title: "Model" };

export const dynamic = "force-dynamic";

/**
 * The join view for one model: everything about it, per provider, plus the
 * actions (playground, compare, keys, waterfall, local variants). Public —
 * the whole page renders signed out and only acting gates. The reserved-slug
 * guard stays: "models" is a static segment, so /models/telemetry must
 * resolve to the Telemetry page, never render as a model named "telemetry".
 */
export default async function ModelDetailPage({
  params,
  searchParams
}: {
  params: Promise<{ modelSlug: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { modelSlug } = await params;
  if (isReservedRouteSlug(modelSlug)) {
    const target = reservedSlugRedirect(modelSlug);
    if (target === null) {
      notFound();
    }
    redirect(target);
  }
  const { created } = await searchParams;
  // The catalog detail is a public read independent of the viewer's session, so
  // fetch it concurrently with the auth cookie read instead of after it — the
  // two were a serial waterfall on this page's hot path (the product owner, perf pass).
  const [user, detail] = await Promise.all([
    getAuthenticatedUser(),
    fetchModelDetail(modelSlug)
  ]);
  if (detail === null) {
    notFound();
  }
  const { model, providers } = detail;
  const org = user === null ? null : await resolveActiveOrg();

  // Key management (the embedded UseViaKeyCard's Azure mapping probe) is
  // admin-level, same rule as ModelApiCard's key minting. The "Ways to use"
  // block reads the org's waterfall override itself through keys-P7's store, so
  // the page no longer fetches it server-side. The two admin checks are
  // independent, so resolve them together rather than in sequence.
  const [platformAdmin, orgAdmin] =
    user !== null && org !== null
      ? await Promise.all([isPlatformAdmin(), isOrgAdmin(user.id, org.id)])
      : [false, false];
  const canManageKeys = platformAdmin || orgAdmin;

  const cheapestInput = cheapestInputMicro({ model, providers });
  const cheapestOutput = cheapestOutputMicro({ model, providers });
  // Serving truth: is this model usable through Experiential on platform
  // credits (any active host-managed route), or is it BYOK-only?
  const served = servedThroughExperiential(providers);

  return (
    // page-bottom-pad: this page scrolls, so it carries the shared bottom
    // padding utility per the AppShell convention (the product owner r4: the detail page
    // ended flush against the viewport).
    <div className="page-bottom-pad flex min-h-0 flex-col gap-5">
      <Link
        className="inline-flex w-fit items-center gap-1.5 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink"
        href={modelsPath()}
      >
        <ArrowLeft aria-hidden size={13} strokeWidth={1.8} />
        Models
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-[18px]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <ModelIcon icon={modelIconKey(model)} name={model.display_name} size={20} />
            <h1 className="m-0 text-xl font-semibold text-ink">{model.display_name}</h1>
            <span className="font-mono text-[11.5px] text-muted-2">{model.slug}</span>
            {model.preferred_rank !== null ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent-amber-soft px-2 py-px font-mono text-[10px] uppercase tracking-wide text-ink-soft">
                <RecommendedStar size={11} />
                recommended
              </span>
            ) : null}
            {model.owning_org_id !== null ? (
              <span className="inline-flex items-center rounded-full bg-purple-soft px-2 py-px font-mono text-[10px] uppercase tracking-wide text-purple">
                your org only
              </span>
            ) : null}
            <span
              className={
                served
                  ? "inline-flex items-center rounded-full bg-accent-soft px-2 py-px font-mono text-[10px] uppercase tracking-wide text-accent"
                  : "inline-flex items-center rounded-full bg-warning-soft px-2 py-px font-mono text-[10px] uppercase tracking-wide text-warning"
              }
              data-testid="serving-badge"
            >
              {served ? "on Experiential" : "bring your own key"}
            </span>
          </div>
          {model.description !== null ? (
            <p className="mt-2 max-w-[780px] text-[13px] leading-relaxed text-muted">
              {model.description}
            </p>
          ) : null}
          {/* Input modalities only — the param-chip strip was cut for clutter
              (the product owner, round-2 2026-08-20); params stay on the catalog table
              and compare views. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <ModalityIcons modalities={model.input_modalities} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            className={buttonClassName("default", undefined, "sm")}
            href={`/models/compare?models=${encodeURIComponent(model.slug)}`}
          >
            <Columns2 aria-hidden size={13} strokeWidth={1.8} />
            Compare
          </Link>
          <Link
            className={buttonClassName("accent", undefined, "sm")}
            href={playgroundPath(model.slug)}
          >
            <SquareTerminal aria-hidden size={13} strokeWidth={1.8} />
            Open in Playground
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-stretch gap-3">
        <Stat label="Context" value={formatTokenCount(model.context_window)} />
        <Stat label="Max output" value={formatTokenCount(model.max_output_tokens)} />
        <Stat label="Input from" value={`${formatPerMillionUsd(cheapestInput)} / M`} />
        <Stat label="Output from" value={`${formatPerMillionUsd(cheapestOutput)} / M`} />
        <Stat label="Released" value={formatReleaseDate(model.release_date)} />
        {model.category !== null ? <Stat label="Category" value={model.category} /> : null}
      </div>

      {created === "1" ? (
        <p className="m-0 rounded-lg border border-line bg-accent-soft/50 px-4 py-2.5 text-[13px] leading-relaxed text-accent">
          Your model is live. It serves through the same gateway endpoint as every other model and
          is visible only to your organization.
        </p>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-5">
          <WaysToUse
            apiBaseUrl={publicServingBaseUrl()}
            canManage={canManageKeys}
            initialDetail={detail}
            modelSlug={model.slug}
            orgId={org?.id ?? null}
            webBaseUrl={process.env.EXPLABS_WEBAPP_URL ?? PLATFORM_WEB_URL}
          />
          <BenchmarksCard
            benchmarks={detail.benchmarks}
            huggingfaceUrl={detail.huggingface_url}
            releaseUrl={detail.release_url}
          />
        </div>
        <QuickstartCard
          modelSlug={model.slug}
          orgId={org?.id ?? null}
          servedThroughExperiential={served}
          servingBaseUrl={publicServingBaseUrl()}
        />
      </div>

      {providers.length > 0 ? (
        // The table stands alone (the product owner r4: no title, no explainer) — its
        // sortable headers and estimate/measured tooltips carry the semantics.
        <section className="flex min-h-0 flex-col">
          <ProvidersTable model={model} providers={providers} />
        </section>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-[130px] flex-col justify-center gap-1 rounded-lg border border-line bg-surface px-4 py-3">
      <p className="mono-label m-0">{label}</p>
      <p className="m-0 font-mono text-[15px] font-semibold text-ink">{value}</p>
    </div>
  );
}
