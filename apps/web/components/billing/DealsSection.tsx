import { ArrowUpRight, Tag } from "lucide-react";

import type { ProviderConnectionState } from "@/components/settings/ModelProvidersPanel";
import { aiCallableConnections } from "@/lib/billing/provider-balances";
import { matchDeals, type Deal } from "@/lib/deals-catalog";

type DealsSectionProps = {
  /** The org's inference accounts; connected ones move deals into "claim". */
  connections: readonly ProviderConnectionState[];
};

/**
 * Inference credit YC deals: one Bookface deal per connectable inference
 * provider, matched against the providers the org has connected. Deals for a
 * connected provider surface first as "claim on providers you use". This
 * section lives on exactly one page (the credits main tab). Copy stays terse
 * and free of em dashes by the product owner's direction.
 */
export function DealsSection({ connections }: DealsSectionProps) {
  const connectedProviders = aiCallableConnections(connections)
    .filter((connection) => connection.connected)
    .map((connection) => connection.provider);
  const { claim, available } = matchDeals(connectedProviders);

  return (
    <section
      className="flex flex-col gap-3 border border-line rounded-lg bg-surface p-[18px]"
      data-testid="deals-section"
    >
      <div className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-md)] border border-line bg-surface text-muted-2">
          <Tag aria-hidden size={13} strokeWidth={1.8} />
        </span>
        <h2 className="m-0 text-sm font-semibold text-ink">Inference credit YC deals</h2>
        <span className="text-[12px] text-muted-2">
          each opens its Bookface deal page
        </span>
      </div>

      {claim.length > 0 && (
        <DealGroup deals={claim} highlight label="Claim on providers you use" />
      )}
      {available.length > 0 && (
        <DealGroup
          deals={available}
          highlight={false}
          label={claim.length > 0 ? "More deals" : "Deals"}
        />
      )}
    </section>
  );
}

function DealGroup({
  deals,
  highlight,
  label
}: {
  deals: Deal[];
  highlight: boolean;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-2">
        {label}
      </span>
      <div className="flex flex-wrap gap-2">
        {deals.map((deal) => (
          <DealChip deal={deal} highlight={highlight} key={deal.id} />
        ))}
      </div>
    </div>
  );
}

function DealChip({ deal, highlight }: { deal: Deal; highlight: boolean }) {
  return (
    <a
      className={
        highlight
          ? "group flex items-center gap-2 rounded-[var(--radius-md)] border border-foreground/30 bg-foreground/[0.04] px-3 py-1.5 transition-colors hover:border-foreground/50"
          : "group flex items-center gap-2 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-1.5 transition-colors hover:border-line-strong"
      }
      data-testid={`deal-${deal.id}`}
      href={deal.url}
      rel="noreferrer"
      target="_blank"
    >
      <span className="flex flex-col">
        <span className="text-[12.5px] font-medium text-ink">{deal.name}</span>
        <span className="text-[11px] text-muted">{deal.headline}</span>
      </span>
      <ArrowUpRight
        aria-hidden
        className="shrink-0 text-muted-2 transition-colors group-hover:text-ink"
        size={13}
        strokeWidth={1.8}
      />
    </a>
  );
}
