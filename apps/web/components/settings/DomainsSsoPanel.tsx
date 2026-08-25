"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { ErrorTile } from "@/components/ui/ErrorTile";
import { Shimmer } from "@/components/ui/Shimmer";
import { readApiError } from "@/components/world-models/wm-client";
import type { OrgDomain, OrgDomainList, SsoProvider, SsoProviderType } from "@/lib/sso";

type DomainsSsoPanelProps = {
  orgId: string;
};

const INPUT_CLASS =
  "min-h-[34px] rounded-[var(--radius-md)] border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";

const LABEL_CLASS = "flex flex-col gap-1 text-[11px] uppercase tracking-[0.04em] text-foreground/40";

/**
 * Admin surface for the SSO substrate (E2): claim domains, publish the TXT
 * record, verify, register the IdP, and require SSO per verified domain.
 * The sso_required toggle stays disabled until BOTH preconditions hold
 * (verified domain + enabled provider) because the backend refuses the
 * lockout state loudly; the helper text explains which half is missing.
 */
export function DomainsSsoPanel({ orgId }: DomainsSsoPanelProps) {
  const [domains, setDomains] = useState<OrgDomain[] | null>(null);
  const [provider, setProvider] = useState<SsoProvider | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Bumped by the ErrorTile's retry so the initial-load effect re-runs.
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    (async () => {
      try {
        const [domainsResponse, providerResponse] = await Promise.all([
          fetch(`/api/orgs/${encodeURIComponent(orgId)}/domains`),
          fetch(`/api/orgs/${encodeURIComponent(orgId)}/sso-provider`)
        ]);
        if (!domainsResponse.ok) {
          if (!cancelled) {
            setError(await readApiError(domainsResponse, "Could not load domains."));
          }
          return;
        }
        const payload = (await domainsResponse.json()) as OrgDomainList;
        // 404 is the honest "no provider yet" — every other failure surfaces.
        let providerPayload: SsoProvider | null = null;
        if (providerResponse.ok) {
          providerPayload = (await providerResponse.json()) as SsoProvider;
        } else if (providerResponse.status !== 404) {
          if (!cancelled) {
            setError(await readApiError(providerResponse, "Could not load the SSO provider."));
          }
          return;
        }
        if (!cancelled) {
          setDomains(payload.domains);
          setProvider(providerPayload);
        }
      } catch {
        if (!cancelled) {
          setError("Could not load the Domains & SSO settings.");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, retryToken]);

  async function mutate<T>(
    key: string,
    request: () => Promise<Response>,
    onPayload: (payload: T) => void,
    fallbackMessage: string
  ): Promise<void> {
    if (busyKey !== null) {
      return;
    }
    setBusyKey(key);
    setError(null);
    try {
      const response = await request();
      if (!response.ok) {
        setError(await readApiError(response, fallbackMessage));
        return;
      }
      onPayload((await response.json()) as T);
    } catch {
      setError(fallbackMessage);
    } finally {
      setBusyKey(null);
    }
  }

  function replaceDomain(updated: OrgDomain): void {
    setDomains((current) =>
      (current ?? []).map((entry) => (entry.domain === updated.domain ? updated : entry))
    );
  }

  // A failed FIRST load has nothing else to show: the ErrorTile with a retry
  // is the whole body (same treatment as the audit log panel).
  if (domains === null && error !== null && !isLoading) {
    return (
      <ErrorTile
        title="Couldn't load Domains & SSO"
        message={error}
        onRetry={() => setRetryToken((token) => token + 1)}
      />
    );
  }

  if (isLoading && domains === null) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-[18px]">
        <Shimmer className="h-4 w-full" />
        <Shimmer className="h-4 w-full" />
        <Shimmer className="h-4 w-2/3" />
      </div>
    );
  }

  const providerEnabled = provider?.enabled === true;
  const hasVerifiedDomain = (domains ?? []).some((entry) => entry.verified_at !== null);

  return (
    <div className="flex flex-col gap-6">
      {error !== null ? (
        <p className="m-0 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-danger text-[13px]">
          {error}
        </p>
      ) : null}

      <DomainsSection
        orgId={orgId}
        domains={domains ?? []}
        providerEnabled={providerEnabled}
        busyKey={busyKey}
        mutate={mutate}
        onCreated={(created) => setDomains((current) => [...(current ?? []), created])}
        onUpdated={replaceDomain}
        onDeleted={(domain) =>
          setDomains((current) => (current ?? []).filter((entry) => entry.domain !== domain))
        }
      />

      <ProviderSection
        orgId={orgId}
        provider={provider}
        hasVerifiedDomain={hasVerifiedDomain}
        busyKey={busyKey}
        mutate={mutate}
        onSaved={setProvider}
        onDeleted={() => setProvider(null)}
      />
    </div>
  );
}

type MutateFn = <T>(
  key: string,
  request: () => Promise<Response>,
  onPayload: (payload: T) => void,
  fallbackMessage: string
) => Promise<void>;

function DomainsSection({
  orgId,
  domains,
  providerEnabled,
  busyKey,
  mutate,
  onCreated,
  onUpdated,
  onDeleted
}: {
  orgId: string;
  domains: OrgDomain[];
  providerEnabled: boolean;
  busyKey: string | null;
  mutate: MutateFn;
  onCreated: (created: OrgDomain) => void;
  onUpdated: (updated: OrgDomain) => void;
  onDeleted: (domain: string) => void;
}) {
  const [newDomain, setNewDomain] = useState("");
  const base = `/api/orgs/${encodeURIComponent(orgId)}/domains`;

  async function addDomain(): Promise<void> {
    const domain = newDomain.trim();
    if (domain.length === 0) {
      return;
    }
    await mutate<OrgDomain>(
      "add",
      () =>
        fetch(base, {
          body: JSON.stringify({ domain }),
          headers: { "content-type": "application/json" },
          method: "POST"
        }),
      (created) => {
        onCreated(created);
        setNewDomain("");
      },
      "Could not claim the domain."
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="m-0 text-ink text-[14px] font-semibold">Verified domains</h3>
        <p className="mt-1 max-w-[720px] text-muted text-[12px] leading-relaxed">
          Claim a domain, publish the TXT record shown below it, then verify. Only verified
          domains can require single sign-on, and a verified domain belongs to exactly one
          organization.
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void addDomain();
        }}
      >
        <label className={LABEL_CLASS}>
          Domain
          <input
            className={`${INPUT_CLASS} min-w-[240px]`}
            onChange={(event) => setNewDomain(event.target.value)}
            placeholder="example.com"
            value={newDomain}
          />
        </label>
        <Button disabled={busyKey !== null || newDomain.trim().length === 0} size="sm" type="submit">
          {busyKey === "add" ? "Claiming…" : "Add domain"}
        </Button>
      </form>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {domains.length === 0 ? (
          <p className="m-0 px-4 py-6 text-center text-muted text-[13px]">
            No domains yet. Claim the domain your members sign in with to unlock single sign-on.
          </p>
        ) : (
          <ul className="m-0 list-none divide-y divide-line/60 p-0">
            {domains.map((entry) => (
              <DomainRow
                key={entry.domain}
                entry={entry}
                base={base}
                providerEnabled={providerEnabled}
                busyKey={busyKey}
                mutate={mutate}
                onUpdated={onUpdated}
                onDeleted={onDeleted}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function DomainRow({
  entry,
  base,
  providerEnabled,
  busyKey,
  mutate,
  onUpdated,
  onDeleted
}: {
  entry: OrgDomain;
  base: string;
  providerEnabled: boolean;
  busyKey: string | null;
  mutate: MutateFn;
  onUpdated: (updated: OrgDomain) => void;
  onDeleted: (domain: string) => void;
}) {
  const verified = entry.verified_at !== null;
  const rowUrl = `${base}/${encodeURIComponent(entry.domain)}`;
  const toggleDisabled = busyKey !== null || !verified || (!entry.sso_required && !providerEnabled);
  const toggleHelp = !verified
    ? "Verify this domain to require single sign-on."
    : !providerEnabled && !entry.sso_required
      ? "Enable an SSO provider below before requiring single sign-on."
      : entry.sso_required
        ? "Sessions must sign in through the identity provider to access this organization."
        : "Members signing in with this domain keep other methods until required.";

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] text-ink">{entry.domain}</span>
        <span
          className={`rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.06em] ${
            verified
              ? "border-accent/30 bg-accent/10 text-accent"
              : "border-line-strong text-muted-2"
          }`}
        >
          {verified ? "Verified" : "Pending"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {!verified ? (
            <Button
              disabled={busyKey !== null}
              onClick={() =>
                void mutate<OrgDomain>(
                  `verify:${entry.domain}`,
                  () => fetch(`${rowUrl}/verify`, { method: "POST" }),
                  onUpdated,
                  "Verification failed."
                )
              }
              size="sm"
            >
              {busyKey === `verify:${entry.domain}` ? "Checking DNS…" : "Verify"}
            </Button>
          ) : null}
          <Button
            disabled={busyKey !== null}
            onClick={() =>
              void mutate<{ deleted: boolean }>(
                `delete:${entry.domain}`,
                () => fetch(rowUrl, { method: "DELETE" }),
                () => onDeleted(entry.domain),
                "Could not remove the domain."
              )
            }
            size="sm"
            variant="ghost"
          >
            Remove
          </Button>
        </div>
      </div>

      {!verified ? (
        <div className="flex flex-col gap-1 rounded-md border border-line bg-background px-3 py-2">
          <p className="m-0 text-[12px] text-muted">
            Publish this DNS TXT record, allow propagation, then verify:
          </p>
          <TxtRecordLine label="Name" value={entry.txt_record_name} />
          <TxtRecordLine label="Value" value={entry.txt_record_value} />
        </div>
      ) : null}

      <label className="flex items-start gap-2 text-[13px] text-ink">
        <input
          checked={entry.sso_required}
          className="mt-0.5"
          disabled={toggleDisabled}
          onChange={(event) =>
            void mutate<OrgDomain>(
              `sso:${entry.domain}`,
              () =>
                fetch(rowUrl, {
                  body: JSON.stringify({ sso_required: event.target.checked }),
                  headers: { "content-type": "application/json" },
                  method: "PATCH"
                }),
              onUpdated,
              "Could not update the SSO requirement."
            )
          }
          type="checkbox"
        />
        <span className="flex flex-col">
          <span>Require single sign-on</span>
          <span className="text-[12px] text-muted">{toggleHelp}</span>
        </span>
      </label>
    </li>
  );
}

function TxtRecordLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-11 shrink-0 text-[10px] uppercase tracking-[0.06em] text-foreground/40">
        {label}
      </span>
      <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] text-ink">
        {value}
      </code>
      <button
        className="shrink-0 cursor-pointer rounded border border-line-strong bg-surface px-1.5 py-0.5 text-[11px] text-ink hover:bg-hover"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        type="button"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function ProviderSection({
  orgId,
  provider,
  hasVerifiedDomain,
  busyKey,
  mutate,
  onSaved,
  onDeleted
}: {
  orgId: string;
  provider: SsoProvider | null;
  hasVerifiedDomain: boolean;
  busyKey: string | null;
  mutate: MutateFn;
  onSaved: (saved: SsoProvider) => void;
  onDeleted: () => void;
}) {
  const [providerType, setProviderType] = useState<SsoProviderType>(
    provider?.provider_type ?? "saml"
  );
  const [metadataUrl, setMetadataUrl] = useState(
    typeof provider?.metadata.metadata_url === "string" ? provider.metadata.metadata_url : ""
  );
  const [issuer, setIssuer] = useState(
    typeof provider?.metadata.issuer === "string" ? provider.metadata.issuer : ""
  );
  const [clientId, setClientId] = useState(
    typeof provider?.metadata.client_id === "string" ? provider.metadata.client_id : ""
  );
  const [clientSecret, setClientSecret] = useState("");
  const [defaultRole, setDefaultRole] = useState<"admin" | "user">(
    provider?.default_role ?? "user"
  );
  const [enabled, setEnabled] = useState(provider?.enabled ?? false);
  const url = `/api/orgs/${encodeURIComponent(orgId)}/sso-provider`;

  async function save(): Promise<void> {
    const metadata =
      providerType === "saml"
        ? { metadata_url: metadataUrl.trim() }
        : { issuer: issuer.trim(), client_id: clientId.trim() };
    await mutate<SsoProvider>(
      "provider:save",
      () =>
        fetch(url, {
          body: JSON.stringify({
            provider_type: providerType,
            metadata,
            default_role: defaultRole,
            enabled,
            ...(providerType === "oidc" && clientSecret.trim().length > 0
              ? { client_secret: clientSecret.trim() }
              : {})
          }),
          headers: { "content-type": "application/json" },
          method: "PUT"
        }),
      (saved) => {
        onSaved(saved);
        setClientSecret("");
      },
      "Could not save the SSO provider."
    );
  }

  const saveDisabled =
    busyKey !== null ||
    (providerType === "saml" ? metadataUrl.trim().length === 0 : issuer.trim().length === 0 || clientId.trim().length === 0);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="m-0 text-ink text-[14px] font-semibold">Identity provider</h3>
        <p className="mt-1 max-w-[720px] text-muted text-[12px] leading-relaxed">
          Register the organization&apos;s SAML or OIDC identity provider. One provider per
          organization; enabling it requires a verified domain. Connecting the provider to the
          hosted sign-in service is completed with your first identity-provider validation.
        </p>
      </div>

      <form
        className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className={LABEL_CLASS}>
            Type
            <Dropdown
              aria-label="Provider type"
              onChange={(event) => setProviderType(event.target.value as SsoProviderType)}
              value={providerType}
            >
              <option value="saml">SAML</option>
              <option value="oidc">OIDC</option>
            </Dropdown>
          </label>
          <label className={LABEL_CLASS}>
            Default role for new members
            <Dropdown
              aria-label="Default role"
              onChange={(event) => setDefaultRole(event.target.value === "admin" ? "admin" : "user")}
              value={defaultRole}
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </Dropdown>
          </label>
        </div>

        {providerType === "saml" ? (
          <label className={LABEL_CLASS}>
            Metadata URL
            <input
              className={`${INPUT_CLASS} max-w-[520px]`}
              onChange={(event) => setMetadataUrl(event.target.value)}
              placeholder="https://idp.example.com/app/metadata.xml"
              value={metadataUrl}
            />
          </label>
        ) : (
          <div className="flex flex-col gap-3">
            <label className={LABEL_CLASS}>
              Issuer
              <input
                className={`${INPUT_CLASS} max-w-[520px]`}
                onChange={(event) => setIssuer(event.target.value)}
                placeholder="https://accounts.example.com"
                value={issuer}
              />
            </label>
            <label className={LABEL_CLASS}>
              Client ID
              <input
                className={`${INPUT_CLASS} max-w-[520px]`}
                onChange={(event) => setClientId(event.target.value)}
                value={clientId}
              />
            </label>
            <label className={LABEL_CLASS}>
              Client secret
              <input
                autoComplete="off"
                className={`${INPUT_CLASS} max-w-[520px]`}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder={
                  provider?.has_client_secret ? "Stored, enter a value to rotate" : undefined
                }
                type="password"
                value={clientSecret}
              />
            </label>
          </div>
        )}

        <label className="flex items-start gap-2 text-[13px] text-ink">
          <input
            checked={enabled}
            className="mt-0.5"
            disabled={!hasVerifiedDomain && !enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            type="checkbox"
          />
          <span className="flex flex-col">
            <span>Enabled</span>
            <span className="text-[12px] text-muted">
              {hasVerifiedDomain || enabled
                ? "An enabled provider is what the sign-in button and the SSO requirement use."
                : "Verify a domain above before enabling the provider."}
            </span>
          </span>
        </label>

        <div className="flex items-center gap-2">
          <Button disabled={saveDisabled} size="sm" type="submit">
            {busyKey === "provider:save" ? "Saving…" : provider ? "Save changes" : "Register provider"}
          </Button>
          {provider ? (
            <Button
              disabled={busyKey !== null}
              onClick={() =>
                void mutate<{ deleted: boolean }>(
                  "provider:delete",
                  () => fetch(url, { method: "DELETE" }),
                  () => onDeleted(),
                  "Could not remove the SSO provider."
                )
              }
              size="sm"
              variant="ghost"
            >
              Remove provider
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
