"use client";

import { useState } from "react";
import { Tag } from "lucide-react";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { ProviderLogo } from "@/components/models-catalog/model-icon";
import {
  ProviderBody,
  providerStatusLine,
  type ProviderConnectionState
} from "@/components/settings/ModelProvidersPanel";
import { ProviderConnectModal } from "@/components/settings/ProviderConnectModal";
import {
  aiCallableConnections,
  providerBalanceLow,
  providerRemainingBalance
} from "@/lib/billing/provider-balances";
import { dealsForProvider } from "@/lib/deals-catalog";
import { formatSignedCostUsd } from "@/lib/money";
import { modelProviderLabel, type ModelProvider } from "@/lib/model-providers";

type ProviderBalanceGridProps = {
  /** Null renders the signed-out grid: every tile connectable via login. */
  orgId: string | null;
  /** Every model-provider account for the org; filtered to AI-callable here. */
  connections: readonly ProviderConnectionState[];
  /** Whether this session may connect/rotate keys (org admins). */
  canManage: boolean;
  /** YC orgs get a small Bookface deal link inside each tile with a deal. */
  isYcCompany: boolean;
  /** Public web origin, threaded to the connect modal's transfer prompt. */
  webBaseUrl: string;
  /** Public API base URL, threaded to the connect modal's transfer prompt. */
  apiBaseUrl: string;
};

/**
 * The compact per-provider balance squares on /credits (the product owner, credits
 * redesign 2026-08-22: the spaced-out balances list becomes a tight grid of
 * logo tiles). Each tile: the provider's brand logo, its connected state, and
 * the balance we track (plus metered spend through the key). Connect opens the
 * SAME modal the settings page uses, IN PLACE — the money page never navigates
 * away to connect — and the connect form here offers the optional starting
 * balance. Every state stays honest: a tracked figure, "not tracked", or "not
 * connected"; never an invented $0.
 */
export function ProviderBalanceGrid({
  orgId,
  connections,
  canManage,
  isYcCompany,
  webBaseUrl,
  apiBaseUrl
}: ProviderBalanceGridProps) {
  const loginModal = useLoginModal();
  const [openProvider, setOpenProvider] = useState<ModelProvider | null>(null);
  const inference = aiCallableConnections(connections);
  const active =
    orgId === null
      ? null
      : (inference.find((connection) => connection.provider === openProvider) ?? null);

  const open = (provider: ModelProvider) => {
    // Signed-out visitors see the whole grid; only acting gates (the connect
    // modal is account-scoped, so the login modal fronts it).
    if (orgId === null) {
      loginModal.open();
      return;
    }
    setOpenProvider(provider);
  };

  return (
    <section className="flex flex-col gap-3" data-testid="provider-balances">
      <div className="flex items-baseline gap-2">
        <h2 className="m-0 text-sm font-semibold text-ink">Provider balances</h2>
        <span className="text-[12px] text-muted-2">your own keys, billed by the provider</span>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {inference.map((connection) => (
          <ProviderTile
            connection={connection}
            isYcCompany={isYcCompany}
            key={connection.provider}
            onOpen={() => open(connection.provider)}
          />
        ))}
      </div>
      {active !== null && orgId !== null && (
        <ProviderConnectModal
          apiBaseUrl={apiBaseUrl}
          canManage={canManage}
          connected={active.connected}
          onClose={() => setOpenProvider(null)}
          provider={active.provider}
          status={providerStatusLine(active)}
          webBaseUrl={webBaseUrl}
        >
          <ProviderBody canManage={canManage} connection={active} offerStartingBalance orgId={orgId} />
        </ProviderConnectModal>
      )}
    </section>
  );
}

function ProviderTile({
  connection,
  isYcCompany,
  onOpen
}: {
  connection: ProviderConnectionState;
  isYcCompany: boolean;
  onOpen: () => void;
}) {
  const label = modelProviderLabel(connection.provider);
  // A provider may carry more than one Bookface deal (Microsoft has two);
  // each gets its own small link row.
  const deals = isYcCompany ? dealsForProvider(connection.provider) : [];
  return (
    <div
      className="flex flex-col rounded-lg border border-line bg-surface transition-colors hover:border-line-strong"
      data-connected={connection.connected}
      data-testid={`provider-balance-${connection.provider}`}
    >
      <button
        aria-label={connection.connected ? `Manage ${label}` : `Connect ${label}`}
        className="flex flex-1 cursor-pointer flex-col items-start gap-2 border-0 bg-transparent p-3 text-left"
        onClick={onOpen}
        type="button"
      >
        <span className="flex w-full items-center justify-between gap-2">
          <span
            aria-hidden
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line bg-foreground/[0.03] text-foreground/70"
          >
            <ProviderLogo provider={connection.provider} size={16} />
          </span>
          {connection.connected ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-accent">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" /> Connected
            </span>
          ) : (
            <span className="text-[11px] font-medium text-muted underline underline-offset-2">
              Connect
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[12.5px] font-semibold text-ink">{label}</span>
          <TileBalance connection={connection} />
        </span>
      </button>
      {deals.map((deal, index) => (
        <a
          className="flex items-center gap-1 border-t border-line px-3 py-1.5 text-[11px] font-medium text-muted transition-colors hover:text-ink"
          data-testid={`yc-deal-${deal.id}`}
          href={deal.url}
          key={deal.id}
          rel="noreferrer"
          target="_blank"
        >
          <Tag aria-hidden size={11} strokeWidth={1.8} />
          {deals.length > 1 ? `YC deal ${index + 1}` : "YC deal"}
        </a>
      ))}
    </div>
  );
}

/**
 * The tile's money line. Connected with a tracked figure: the remaining
 * declared balance (or the provider-reported credits when that is all we
 * have), warn-colored when low, with metered spend under it. Anything else
 * says what it is.
 */
function TileBalance({ connection }: { connection: ProviderConnectionState }) {
  if (!connection.connected) {
    return <span className="text-[12px] text-muted-2">Not connected</span>;
  }
  const remaining = providerRemainingBalance(connection);
  const low = providerBalanceLow(connection);
  const reported = connection.latestSnapshot?.credits_remaining_usd ?? null;
  const figure = remaining ?? reported;
  return (
    <span className="flex flex-col gap-0.5">
      {figure === null ? (
        <span className="text-[12px] text-muted-2">Balance not tracked</span>
      ) : (
        <span
          className={
            low ? "text-[15px] font-semibold text-warning" : "text-[15px] font-semibold text-ink"
          }
        >
          {formatSignedCostUsd(figure)}
          {low && <span className="ml-1 text-[11px] font-medium">low</span>}
        </span>
      )}
      {connection.meteredSpendUsd > 0 && (
        <span className="text-[11px] text-muted">
          ${connection.meteredSpendUsd.toFixed(2)} spent on this key
        </span>
      )}
    </span>
  );
}
