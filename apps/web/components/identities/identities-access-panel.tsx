"use client";

// The "Identities & access" tier of the Access control page: the clickable
// surface over the gateway identity tier. An identity owns its keys (P-A
// reparent), the aliases it may call (P-B deny-by-default grants), and its
// monthly spend caps (P-C budgets).
// Budgets now come in four scopes (organization, identity, single API key,
// single model) and two lifetimes (pinned to one month, or recurring every
// month). Reads arrive as server props; mutations go through the Next BFF and
// the panel calls router.refresh() so the server re-reads. Keys reuse the
// shipped OrgApiKeysSection (one-time reveal, soft revoke), scoped to the
// identity.

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Ban, Check, Pencil, Plus, ShieldCheck, Users, Wallet } from "lucide-react";

import { useLoginModal } from "@/components/auth/login-modal-context";
import { OrgApiKeysSection } from "@/components/keys/org-api-keys-section";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  createIdentity,
  deleteBudget,
  disableIdentity,
  renameIdentity,
  setBudget,
  setGrant
} from "@/components/identities/api";
import { formatKeyIdentity } from "@/lib/api-keys/format";
import type { ApiKeySummary } from "@/lib/api-keys/types";
import {
  RECURRING_PERIOD,
  type BudgetView,
  type GrantMatrix,
  type IdentityView
} from "@/lib/identities/types";

export type IdentitiesAccessPanelProps = {
  orgId: string;
  canManage: boolean;
  period: string;
  identities: IdentityView[];
  matrix: GrantMatrix;
  budgets: BudgetView[];
  /** The org's active keys, for the key-budget picker and key-row labels. */
  keys: ApiKeySummary[];
};

const EYEBROW = "text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint";

export function IdentitiesAccessPanel(props: IdentitiesAccessPanelProps) {
  const { orgId, canManage, period, identities, matrix, budgets, keys } = props;
  const router = useRouter();
  const { requireAuth } = useLoginModal();

  const [selectedId, setSelectedId] = useState<string | null>(
    identities.length > 0 ? identities[0].identity_id : null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected =
    identities.find((identity) => identity.identity_id === selectedId) ?? identities[0] ?? null;

  // A mutation runs behind the login gate, surfaces any failure inline, and
  // refreshes the server props on success so every pane re-reads at once.
  function run(action: () => Promise<unknown>) {
    requireAuth(() => {
      void (async () => {
        setError(null);
        setBusy(true);
        try {
          await action();
          router.refresh();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "The request failed.");
        } finally {
          setBusy(false);
        }
      })();
    });
  }

  // A month's read can hold up to two rows per scope: the recurring cap and a
  // cap pinned to this month (the gate enforces both; the tightest wins).
  const teamBudgets = budgets.filter((budget) => budget.scope_kind === "team");
  const scopedBudgets = budgets.filter(
    (budget) => budget.scope_kind === "key" || budget.scope_kind === "model"
  );

  return (
    <div className="flex min-h-0 flex-col gap-4 lg:flex-1">
      <div className="shrink-0">
        <h2 className="m-0 text-ink text-[15px] font-semibold">Identities &amp; access</h2>
        <p className="m-0 mt-1 max-w-[780px] text-[13px] leading-relaxed text-muted">
          Identities are the principals in your organization: a team, a project, or a service.
          Each owns its API keys, the models it may call, and its monthly spend caps. New
          identities start with no access; grant the models they need.
        </p>
      </div>

      {error !== null && (
        <div className="shrink-0 rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      )}

      {/* At xl the two org-wide budget cards share one row and one capped
          scrollport, so the identity tier below keeps its viewport share
          however many caps exist. Below xl they stack single-column and size
          naturally, capping the stack would bury the second card below an
          inner fold; the identity grid's min-height floor pushes overflow
          into the main scroll instead. */}
      <div className="grid shrink-0 grid-cols-1 gap-4 xl:max-h-[30vh] xl:grid-cols-2 xl:overflow-y-auto">
        <TeamBudgetStrip
          budgets={teamBudgets}
          canManage={canManage}
          busy={busy}
          period={period}
          onSet={(limitMicroUsd, recurring) =>
            run(() =>
              setBudget(orgId, {
                period: recurring ? RECURRING_PERIOD : period,
                scope_kind: "team",
                limit_micro_usd: limitMicroUsd
              })
            )
          }
          onClear={(budgetId) => run(() => deleteBudget(orgId, budgetId))}
        />

        <KeyModelBudgetsSection
          aliases={matrix.aliases}
          budgets={scopedBudgets}
          canManage={canManage}
          busy={busy}
          keys={keys}
          period={period}
          onSet={(input) =>
            run(() =>
              setBudget(orgId, {
                period: input.recurring ? RECURRING_PERIOD : period,
                scope_kind: input.scopeKind,
                limit_micro_usd: input.limitMicroUsd,
                ...(input.scopeKind === "key"
                  ? { api_key_id: input.targetId }
                  : { alias_id: input.targetId })
              })
            )
          }
          onClear={(budgetId) => run(() => deleteBudget(orgId, budgetId))}
        />
      </div>

      {/* The min-height floor keeps the identity tier usable on short
          viewports: without it the fixed-share blocks above can consume the
          whole lg:h-full and this grid collapses to zero height with nothing
          to scroll. When the floor kicks in, the page overflows into the app
          shell's main scroll. */}
      <div className="grid min-h-0 grid-cols-1 gap-4 lg:min-h-[16rem] lg:flex-1 lg:grid-cols-[300px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
        <IdentityList
          identities={identities}
          selectedId={selected?.identity_id ?? null}
          canManage={canManage}
          busy={busy}
          onSelect={setSelectedId}
          onCreate={(displayName) =>
            run(async () => {
              const created = await createIdentity(orgId, { display_name: displayName });
              setSelectedId(created.identity_id);
            })
          }
        />

        {selected === null ? (
          <div className="grid place-items-center rounded-lg border border-line bg-surface p-[18px] text-[13px] text-muted">
            Create an identity to manage its keys, access, and budget.
          </div>
        ) : (
          <IdentityDetail
            key={selected.identity_id}
            orgId={orgId}
            canManage={canManage}
            busy={busy}
            period={period}
            identity={selected}
            matrix={matrix}
            budgets={budgets.filter(
              (budget) =>
                budget.scope_kind === "identity" && budget.identity_id === selected.identity_id
            )}
            onRename={(displayName) =>
              run(() => renameIdentity(orgId, selected.identity_id, { display_name: displayName }))
            }
            onToggleActive={(active) =>
              run(() =>
                active
                  ? renameIdentity(orgId, selected.identity_id, { active: true })
                  : disableIdentity(orgId, selected.identity_id)
              )
            }
            onToggleGrant={(aliasId, granted) =>
              run(() => setGrant(orgId, selected.identity_id, aliasId, granted))
            }
            onSetBudget={(limitMicroUsd, recurring) =>
              run(() =>
                setBudget(orgId, {
                  period: recurring ? RECURRING_PERIOD : period,
                  scope_kind: "identity",
                  identity_id: selected.identity_id,
                  limit_micro_usd: limitMicroUsd
                })
              )
            }
            onClearBudget={(budgetId) => run(() => deleteBudget(orgId, budgetId))}
          />
        )}
      </div>
    </div>
  );
}

// -- Team budget -------------------------------------------------------------

function TeamBudgetStrip(props: {
  budgets: BudgetView[];
  canManage: boolean;
  busy: boolean;
  period: string;
  onSet: (limitMicroUsd: number, recurring: boolean) => void;
  onClear: (budgetId: string) => void;
}) {
  const { budgets, canManage, busy, period, onSet, onClear } = props;
  return (
    <section className="rounded-lg border border-line bg-surface p-[18px]">
      <div className="flex items-center gap-2">
        <Users aria-hidden className="text-ink-faint" size={15} strokeWidth={1.8} />
        <span className={EYEBROW}>Organization budget · {period}</span>
      </div>
      <div className="mt-3">
        <BudgetScopeBlock
          budgets={budgets}
          canManage={canManage}
          busy={busy}
          label="organization"
          period={period}
          onSet={onSet}
          onClear={onClear}
        />
      </div>
    </section>
  );
}

// -- Key & model budgets -----------------------------------------------------

type ScopedBudgetInput = {
  scopeKind: "key" | "model";
  targetId: string;
  limitMicroUsd: number;
  recurring: boolean;
};

/**
 * Org-wide caps on a single API key or a single model (alias). These stack
 * with the organization and identity caps: the reservation gate checks every
 * matching scope, so the tightest cap wins.
 */
function KeyModelBudgetsSection(props: {
  budgets: BudgetView[];
  keys: ApiKeySummary[];
  aliases: GrantMatrix["aliases"];
  canManage: boolean;
  busy: boolean;
  period: string;
  onSet: (input: ScopedBudgetInput) => void;
  onClear: (budgetId: string) => void;
}) {
  const { budgets, keys, aliases, canManage, busy, period, onSet, onClear } = props;
  const [adding, setAdding] = useState(false);

  return (
    <section className="rounded-lg border border-line bg-surface p-[18px]">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Wallet aria-hidden className="text-ink-faint" size={15} strokeWidth={1.8} />
          <span className={EYEBROW}>Key &amp; model budgets · {period}</span>
        </div>
        {canManage && !adding && (
          <Button disabled={busy} onClick={() => setAdding(true)} size="sm" type="button">
            <Plus aria-hidden size={13} strokeWidth={1.8} />
            Add budget
          </Button>
        )}
      </div>
      <p className="m-0 mt-2 max-w-[780px] text-[13px] leading-relaxed text-muted">
        Cap one API key or one model across the whole organization. These caps stack with the
        organization and identity budgets; the tightest one wins.
      </p>

      {adding && (
        <div className="mt-3">
          <ScopedBudgetForm
            aliases={aliases}
            busy={busy}
            keys={keys}
            onCancel={() => setAdding(false)}
            onSubmit={(input) => {
              onSet(input);
              setAdding(false);
            }}
          />
        </div>
      )}

      {budgets.length === 0 ? (
        !adding && (
          <p className="m-0 mt-3 text-[13px] text-muted">No key or model caps set; unlimited.</p>
        )
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {budgets.map((budget) => (
            <li className="flex flex-col gap-1.5" key={budget.budget_id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {scopedBudgetLabel(budget, keys, aliases)}
                  </span>
                  <BudgetPeriodChip budget={budget} />
                </span>
                {canManage && (
                  <Button
                    disabled={busy}
                    onClick={() => onClear(budget.budget_id)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Remove cap
                  </Button>
                )}
              </div>
              <BudgetMeter budget={budget} />
              <PinnedBudgetHint budget={budget} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function scopedBudgetLabel(
  budget: BudgetView,
  keys: ApiKeySummary[],
  aliases: GrantMatrix["aliases"]
): string {
  if (budget.scope_kind === "key") {
    const key = keys.find((candidate) => candidate.id === budget.api_key_id);
    // A revoked key's budget row survives the key; fall back to the raw id.
    return key === undefined
      ? `API key ${budget.api_key_id ?? "(unknown)"}`
      : `API key · ${key.name} (${formatKeyIdentity(key.key_prefix, key.key_suffix)})`;
  }
  const alias = aliases.find((candidate) => candidate.alias_id === budget.alias_id);
  return alias === undefined
    ? `Model ${budget.alias_id ?? "(unknown)"}`
    : `Model · ${alias.alias_name}`;
}

function ScopedBudgetForm(props: {
  keys: ApiKeySummary[];
  aliases: GrantMatrix["aliases"];
  busy: boolean;
  onSubmit: (input: ScopedBudgetInput) => void;
  onCancel: () => void;
}) {
  const { keys, aliases, busy, onSubmit, onCancel } = props;
  const scopeId = useId();
  const targetId = useId();
  const amountId = useId();
  const [scopeKind, setScopeKind] = useState<"key" | "model">("key");
  const [target, setTarget] = useState("");
  const [value, setValue] = useState("");
  const [recurring, setRecurring] = useState(false);

  const options =
    scopeKind === "key"
      ? keys.map((key) => ({
          id: key.id,
          label: `${key.name} (${formatKeyIdentity(key.key_prefix, key.key_suffix)})`
        }))
      : aliases.map((alias) => ({ id: alias.alias_id, label: alias.alias_name }));
  const dollars = Number(value);
  const valid =
    target.length > 0 && value.trim().length > 0 && Number.isFinite(dollars) && dollars >= 0;

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-background p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) {
          return;
        }
        onSubmit({
          scopeKind,
          targetId: target,
          limitMicroUsd: Math.round(dollars * 1_000_000),
          recurring
        });
      }}
    >
      <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint" htmlFor={scopeId}>
        Scope
        <select
          className="min-h-[30px] rounded-md border border-line bg-surface px-2 text-[13px] font-normal normal-case tracking-normal text-foreground focus:border-line-strong focus:outline-none"
          id={scopeId}
          onChange={(event) => {
            setScopeKind(event.target.value === "model" ? "model" : "key");
            setTarget("");
          }}
          value={scopeKind}
        >
          <option value="key">API key</option>
          <option value="model">Model</option>
        </select>
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint" htmlFor={targetId}>
        {scopeKind === "key" ? "Key" : "Model"}
        <select
          className="min-h-[30px] max-w-[260px] rounded-md border border-line bg-surface px-2 text-[13px] font-normal normal-case tracking-normal text-foreground focus:border-line-strong focus:outline-none"
          id={targetId}
          onChange={(event) => setTarget(event.target.value)}
          value={target}
        >
          <option disabled value="">
            {options.length === 0
              ? scopeKind === "key"
                ? "No active keys"
                : "No models"
              : `Pick a ${scopeKind === "key" ? "key" : "model"}…`}
          </option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint" htmlFor={amountId}>
        Monthly cap (USD)
        <input
          className="w-24 rounded-md border border-line bg-surface px-2 py-1 text-[13px] font-normal normal-case tracking-normal text-foreground focus:border-line-strong focus:outline-none"
          id={amountId}
          inputMode="decimal"
          min={0}
          onChange={(event) => setValue(event.target.value)}
          placeholder="0.00"
          step="0.01"
          type="number"
          value={value}
        />
      </label>
      <RepeatsMonthlyToggle checked={recurring} onChange={setRecurring} />
      <div className="flex items-center gap-2">
        <Button disabled={busy || !valid} size="sm" type="submit" variant="primary">
          Save
        </Button>
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
    </form>
  );
}

// -- Identity list -----------------------------------------------------------

function IdentityList(props: {
  identities: IdentityView[];
  selectedId: string | null;
  canManage: boolean;
  busy: boolean;
  onSelect: (identityId: string) => void;
  onCreate: (displayName: string) => void;
}) {
  const { identities, selectedId, canManage, busy, onSelect, onCreate } = props;
  const [name, setName] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim().length === 0) {
      return;
    }
    onCreate(name.trim());
    setName("");
  }

  return (
    <section className="flex max-h-[70vh] min-h-0 flex-col rounded-lg border border-line bg-surface lg:max-h-none">
      <div className="border-b border-line px-[18px] py-3">
        <span className={EYEBROW}>Identities</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {identities.map((identity) => {
          const isActive = identity.identity_id === selectedId;
          return (
            <li key={identity.identity_id}>
              <button
                aria-current={isActive ? "true" : undefined}
                className={
                  "flex w-full flex-col gap-1 border-b border-line px-[18px] py-3 text-left transition-colors " +
                  (isActive ? "bg-accent-soft" : "hover:bg-hover")
                }
                onClick={() => onSelect(identity.identity_id)}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {identity.display_name}
                  </span>
                  {identity.is_default && <Chip label="Default" tone="queued" />}
                  {!identity.active && <Chip label="Disabled" tone="cancelled" />}
                </span>
                <span className="font-mono text-[11px] text-ink-faint">
                  {identity.active_key_count} {identity.active_key_count === 1 ? "key" : "keys"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {canManage && (
        <form className="flex items-center gap-2 border-t border-line p-3" onSubmit={submit}>
          <input
            aria-label="New identity name"
            className="min-w-0 flex-1 rounded-md border border-line bg-background px-3 py-2 text-[13px] focus:border-line-strong focus:outline-none"
            disabled={busy}
            maxLength={256}
            onChange={(event) => setName(event.target.value)}
            placeholder="New identity name"
            value={name}
          />
          <Button disabled={busy || name.trim().length === 0} size="sm" type="submit" variant="primary">
            <Plus aria-hidden size={13} strokeWidth={1.8} />
            Add
          </Button>
        </form>
      )}
    </section>
  );
}

// -- Identity detail ---------------------------------------------------------

function IdentityDetail(props: {
  orgId: string;
  canManage: boolean;
  busy: boolean;
  period: string;
  identity: IdentityView;
  matrix: GrantMatrix;
  budgets: BudgetView[];
  onRename: (displayName: string) => void;
  onToggleActive: (active: boolean) => void;
  onToggleGrant: (aliasId: string, granted: boolean) => void;
  onSetBudget: (limitMicroUsd: number, recurring: boolean) => void;
  onClearBudget: (budgetId: string) => void;
}) {
  const {
    orgId,
    canManage,
    busy,
    period,
    identity,
    matrix,
    budgets,
    onRename,
    onToggleActive,
    onToggleGrant,
    onSetBudget,
    onClearBudget
  } = props;

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(identity.display_name);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const grantedAliasIds = new Set(
    matrix.grants
      .filter((grant) => grant.identity_id === identity.identity_id)
      .map((grant) => grant.alias_id)
  );

  return (
    <section className="flex max-h-[70vh] min-h-0 flex-col gap-4 overflow-y-auto rounded-lg border border-line bg-surface p-[18px] lg:max-h-none">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {editing ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (draftName.trim().length > 0 && draftName.trim() !== identity.display_name) {
                  onRename(draftName.trim());
                }
                setEditing(false);
              }}
            >
              <input
                aria-label="Identity name"
                autoFocus
                className="rounded-md border border-line bg-background px-2 py-1 text-[15px] font-semibold focus:border-line-strong focus:outline-none"
                maxLength={256}
                onChange={(event) => setDraftName(event.target.value)}
                value={draftName}
              />
              <Button disabled={busy} size="sm" type="submit" variant="primary">
                Save
              </Button>
              <Button
                onClick={() => {
                  setDraftName(identity.display_name);
                  setEditing(false);
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-2">
              <h3 className="m-0 truncate text-[15px] font-semibold text-foreground">
                {identity.display_name}
              </h3>
              {identity.is_default && <Chip label="Default" tone="queued" />}
              {!identity.active && <Chip label="Disabled" tone="cancelled" />}
              {canManage && !identity.is_default && (
                <button
                  aria-label="Rename identity"
                  className="text-ink-faint hover:text-foreground"
                  onClick={() => {
                    setDraftName(identity.display_name);
                    setEditing(true);
                  }}
                  type="button"
                >
                  <Pencil aria-hidden size={13} strokeWidth={1.8} />
                </button>
              )}
            </div>
          )}
          <p className="m-0 mt-1 font-mono text-[11px] text-ink-faint">{identity.identity_id}</p>
        </div>
        {canManage && !identity.is_default && identity.active && (
          <Button
            disabled={busy}
            onClick={() => setConfirmDisable(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Ban aria-hidden size={13} strokeWidth={1.8} />
            Disable
          </Button>
        )}
        {canManage && !identity.is_default && !identity.active && (
          <Button disabled={busy} onClick={() => onToggleActive(true)} size="sm" type="button">
            Re-enable
          </Button>
        )}
      </header>

      <div className="flex flex-col gap-2">
        <span className={EYEBROW}>API keys</span>
        <OrgApiKeysSection canManage={canManage} identityId={identity.identity_id} orgId={orgId} />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck aria-hidden className="text-ink-faint" size={15} strokeWidth={1.8} />
          <span className={EYEBROW}>Granted models</span>
        </div>
        <GrantGrid
          aliases={matrix.aliases}
          grantedAliasIds={grantedAliasIds}
          canManage={canManage}
          busy={busy}
          onToggle={onToggleGrant}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className={EYEBROW}>Monthly budget · {period}</span>
        <BudgetScopeBlock
          budgets={budgets}
          canManage={canManage}
          busy={busy}
          label={identity.display_name}
          period={period}
          onSet={onSetBudget}
          onClear={onClearBudget}
        />
      </div>

      <ConfirmDialog
        body={`Disable ${identity.display_name}? Its keys keep working until you revoke them; this hides the identity as inactive.`}
        busy={busy}
        busyLabel="Disabling…"
        confirmLabel="Disable identity"
        onCancel={() => setConfirmDisable(false)}
        onConfirm={() => {
          onToggleActive(false);
          setConfirmDisable(false);
        }}
        open={confirmDisable}
        title="Disable identity"
        tone="warning"
      />
    </section>
  );
}

// -- Grant grid --------------------------------------------------------------

function GrantGrid(props: {
  aliases: GrantMatrix["aliases"];
  grantedAliasIds: Set<string>;
  canManage: boolean;
  busy: boolean;
  onToggle: (aliasId: string, granted: boolean) => void;
}) {
  const { aliases, grantedAliasIds, canManage, busy, onToggle } = props;
  if (aliases.length === 0) {
    return (
      <p className="m-0 rounded-lg border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">
        No models are available to grant yet.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {aliases.map((alias) => {
        const granted = grantedAliasIds.has(alias.alias_id);
        return (
          <li key={alias.alias_id}>
            <button
              aria-pressed={granted}
              className={
                "flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-[13px] transition-colors " +
                (granted
                  ? "border-accent/40 bg-accent-soft"
                  : "border-line bg-surface hover:bg-hover") +
                (canManage ? " cursor-pointer" : " cursor-default")
              }
              disabled={!canManage || busy}
              onClick={() => onToggle(alias.alias_id, !granted)}
              type="button"
            >
              <span className="min-w-0">
                <span className="block truncate font-mono text-[12px] text-foreground">
                  {alias.alias_name}
                </span>
                <span className="text-[10px] uppercase tracking-[0.06em] text-ink-faint">
                  {alias.org_scoped ? "Custom" : "Catalog"}
                </span>
              </span>
              <span
                className={
                  "grid h-4 w-4 shrink-0 place-items-center rounded-sm border " +
                  (granted ? "border-accent bg-accent text-white" : "border-line-strong")
                }
              >
                {granted && <Check aria-hidden size={11} strokeWidth={2.5} />}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// -- Budget rows, editor, meter ----------------------------------------------

/**
 * All the budgets of one scope for the read month — up to two rows, a
 * recurring cap and one pinned to this month — each with its lifetime marker
 * and meter, plus the single editor that writes either lifetime.
 */
function BudgetScopeBlock(props: {
  budgets: BudgetView[];
  canManage: boolean;
  busy: boolean;
  label: string;
  period: string;
  onSet: (limitMicroUsd: number, recurring: boolean) => void;
  onClear: (budgetId: string) => void;
}) {
  const { budgets, canManage, busy, label, period, onSet, onClear } = props;
  const [editing, setEditing] = useState<{ value: string; recurring: boolean } | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {budgets.length === 0 && (
        <div className="flex items-center justify-between gap-2">
          <p className="m-0 text-[13px] text-muted">No cap set; unlimited this month.</p>
          {canManage && editing === null && (
            <Button
              disabled={busy}
              onClick={() => setEditing({ value: "", recurring: false })}
              size="sm"
              type="button"
            >
              Set cap
            </Button>
          )}
        </div>
      )}
      {budgets.map((budget) => (
        <div className="flex flex-col gap-1.5" key={budget.budget_id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BudgetPeriodChip budget={budget} />
            {canManage && (
              <span className="flex items-center gap-2">
                <Button
                  disabled={busy}
                  onClick={() => onClear(budget.budget_id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Remove cap
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    setEditing({
                      value: String(budget.limit_micro_usd / 1_000_000),
                      recurring: budget.period === RECURRING_PERIOD
                    })
                  }
                  size="sm"
                  type="button"
                >
                  Edit cap
                </Button>
              </span>
            )}
          </div>
          <BudgetMeter budget={budget} />
          <PinnedBudgetHint budget={budget} />
        </div>
      ))}
      {budgets.length > 0 && canManage && editing === null && (
        // Both lifetimes present is the ceiling; offer the second slot only
        // while one is free.
        budgets.length < 2 && (
          <div>
            <Button
              disabled={busy}
              onClick={() =>
                setEditing({
                  value: "",
                  recurring: !budgets.some((budget) => budget.period === RECURRING_PERIOD)
                })
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              Add another cap
            </Button>
          </div>
        )
      )}
      {editing !== null && (
        <BudgetEditorForm
          busy={busy}
          initial={editing}
          label={label}
          period={period}
          onCancel={() => setEditing(null)}
          onSave={(limitMicroUsd, recurring) => {
            onSet(limitMicroUsd, recurring);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function BudgetEditorForm(props: {
  busy: boolean;
  label: string;
  period: string;
  initial: { value: string; recurring: boolean };
  onSave: (limitMicroUsd: number, recurring: boolean) => void;
  onCancel: () => void;
}) {
  const { busy, label, period, initial, onSave, onCancel } = props;
  // Unique per instance: the org and identity editors render together, so a
  // shared static id would mis-associate the label / assistive-tech focus.
  const inputId = useId();
  const [value, setValue] = useState(initial.value);
  const [recurring, setRecurring] = useState(initial.recurring);

  return (
    <form
      className="flex flex-wrap items-center gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const dollars = Number(value);
        if (Number.isFinite(dollars) && dollars >= 0 && value.trim().length > 0) {
          onSave(Math.round(dollars * 1_000_000), recurring);
        }
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        Monthly cap for {label} in US dollars
      </label>
      <span className="flex items-center gap-2">
        <span className="text-[13px] text-muted">$</span>
        <input
          className="w-24 rounded-md border border-line bg-background px-2 py-1 text-[13px] focus:border-line-strong focus:outline-none"
          id={inputId}
          inputMode="decimal"
          min={0}
          onChange={(event) => setValue(event.target.value)}
          placeholder="0.00"
          step="0.01"
          type="number"
          value={value}
        />
      </span>
      <RepeatsMonthlyToggle checked={recurring} onChange={setRecurring} />
      {!recurring && (
        <span className="text-[11px] text-warning">Applies to {period} only.</span>
      )}
      <Button disabled={busy} size="sm" type="submit" variant="primary">
        Save
      </Button>
      <Button onClick={onCancel} size="sm" type="button" variant="ghost">
        Cancel
      </Button>
    </form>
  );
}

function RepeatsMonthlyToggle(props: { checked: boolean; onChange: (next: boolean) => void }) {
  const { checked, onChange } = props;
  return (
    <label className="flex items-center gap-2 text-[13px] text-muted">
      <input
        checked={checked}
        className="h-4 w-4 accent-foreground"
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      Repeats monthly
    </label>
  );
}

function BudgetPeriodChip({ budget }: { budget: BudgetView }) {
  return budget.period === RECURRING_PERIOD ? (
    <Chip label="Recurring" tone="complete" />
  ) : (
    <Chip label="This month only" tone="queued" />
  );
}

/** The must-see caveat on a pinned-month cap: it dies with its month. */
function PinnedBudgetHint({ budget }: { budget: BudgetView }) {
  if (budget.period === RECURRING_PERIOD) {
    return null;
  }
  return (
    <p className="m-0 text-[11px] text-warning">
      Pinned to {budget.period}: this cap stops enforcing when the month ends. Turn on
      &ldquo;Repeats monthly&rdquo; to keep it.
    </p>
  );
}

function BudgetMeter({ budget }: { budget: BudgetView }) {
  const spent = budget.reserved_micro_usd + budget.settled_micro_usd;
  const fraction = budget.limit_micro_usd === 0 ? 1 : Math.min(1, spent / budget.limit_micro_usd);
  const settledFraction =
    budget.limit_micro_usd === 0 ? 0 : Math.min(1, budget.settled_micro_usd / budget.limit_micro_usd);
  const overish = fraction >= 0.9;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-subtle">
        <div
          className={overish ? "bg-danger" : "bg-accent"}
          style={{ width: `${settledFraction * 100}%` }}
        />
        <div
          className={overish ? "bg-danger/50" : "bg-accent/50"}
          style={{ width: `${Math.max(0, fraction - settledFraction) * 100}%` }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-ink-faint">
        <span>settled {formatUsd(budget.settled_micro_usd)}</span>
        <span>reserved {formatUsd(budget.reserved_micro_usd)}</span>
        <span className="text-foreground">remaining {formatUsd(budget.remaining_micro_usd)}</span>
        <span>of {formatUsd(budget.limit_micro_usd)}</span>
      </div>
    </div>
  );
}

function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}
