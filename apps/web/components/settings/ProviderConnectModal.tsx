"use client";

// The connect/manage popup for one model provider. Clicking a provider tile
// opens this instead of expanding an inline row (the product owner, 2026-08-21: connecting
// a provider is a focused task, so it earns a modal, not a dropdown). It is a
// thin binding over the shared ConnectModal shell: the provider's real brand
// logo (the same ProviderLogo the models page paints), the curated per-provider
// transfer prompt for the customer's coding agent, and the existing credential
// form passed through as children so the form logic stays in one place. The
// same shell now serves the trace sources too (IntegrationsPanel).

import type { ReactNode } from "react";

import { ProviderLogo } from "@/components/models-catalog/model-icon";
import { ConnectModal } from "@/components/settings/ConnectModal";
import { buildProviderTransferPrompt } from "@/components/settings/provider-transfer-prompt";
import { modelProviderLabel, type ModelProvider } from "@/lib/model-providers";

type ProviderConnectModalProps = {
  provider: ModelProvider;
  connected: boolean;
  /** The one-line status shown under the provider name (verified state, balance). */
  status: string;
  /**
   * Whether the transfer prompt shows. It drives an admin-scoped connect (the
   * PUT needs manager rights), so it is hidden for read-only members, matching
   * the credential form the children render.
   */
  canManage: boolean;
  /** Public web origin, for the prompt's manage-keys pointer. */
  webBaseUrl: string;
  /** Public API base URL, for the prompt's whoami + connect calls. */
  apiBaseUrl: string;
  onClose: () => void;
  /** The per-provider credential form (ProviderBody). */
  children: ReactNode;
};

export function ProviderConnectModal({
  provider,
  connected,
  status,
  canManage,
  webBaseUrl,
  apiBaseUrl,
  onClose,
  children
}: ProviderConnectModalProps) {
  return (
    <ConnectModal
      connected={connected}
      icon={<ProviderLogo provider={provider} size={18} />}
      onClose={onClose}
      prompt={canManage ? buildProviderTransferPrompt(provider, webBaseUrl, apiBaseUrl) : null}
      promptTestId={`provider-transfer-prompt-${provider}`}
      status={status}
      testId={`provider-connect-modal-${provider}`}
      title={modelProviderLabel(provider)}
    >
      {children}
    </ConnectModal>
  );
}
