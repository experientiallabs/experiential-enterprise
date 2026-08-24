"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";

import { Button } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Dropdown";
import { LocalDateTime } from "@/components/ui/LocalDateTime";
import { readApiError } from "@/components/world-models/wm-client";
import type { AliasModelOption, AliasRevision, NamedAlias } from "@/lib/aliases/types";

type AliasesPanelProps = {
  aliases: NamedAlias[];
  models: AliasModelOption[];
  orgId: string;
};

const EYEBROW = "text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint";

// The table header stays readable while the table scrolls inside the card;
// the inset shadow stands in for a border that sticky headers scroll away.
const TH = `sticky top-0 bg-surface px-4 py-2 text-left shadow-[inset_0_-1px_0_var(--line)] ${EYEBROW}`;

/**
 * Admin surface: create, repoint, roll back, and retire named model aliases.
 * One card: the section header and create form share the top row, the alias
 * table scrolls internally below, so the page's identity tier keeps the rest
 * of the viewport (access-control page redesign 2026-08-23).
 */
export function AliasesPanel({ aliases, models, orgId }: AliasesPanelProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newModel, setNewModel] = useState(models[0]?.slug ?? "");
  const [repointModel, setRepointModel] = useState<Record<string, string>>({});
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<AliasRevision[]>([]);

  async function run(key: string, action: () => Promise<Response>, success: string): Promise<void> {
    setError(null);
    setNotice(null);
    setBusyKey(key);
    try {
      const response = await action();
      if (!response.ok) {
        setError(await readApiError(response, "The operation failed."));
        return;
      }
      setNotice(success);
      router.refresh();
    } catch {
      // A network-level rejection must surface inline (and not escape as an
      // unhandled promise rejection with the busy latch already cleared).
      setError("The operation failed.");
    } finally {
      setBusyKey(null);
    }
  }

  async function createAlias(): Promise<void> {
    await run(
      "create",
      () =>
        fetch("/api/aliases", {
          body: JSON.stringify({ org_id: orgId, name: newName.trim(), model: newModel }),
          headers: { "content-type": "application/json" },
          method: "POST"
        }),
      `Alias '${newName.trim()}' created.`
    );
    setNewName("");
  }

  async function repoint(name: string): Promise<void> {
    const model = repointModel[name];
    if (!model) return;
    await run(
      `repoint:${name}`,
      () =>
        fetch(`/api/aliases/${encodeURIComponent(name)}`, {
          body: JSON.stringify({ org_id: orgId, model }),
          headers: { "content-type": "application/json" },
          method: "PUT"
        }),
      `Alias '${name}' now points at ${model}.`
    );
  }

  async function retire(name: string): Promise<void> {
    if (!window.confirm(`Retire alias '${name}'? Calls to it will stop resolving.`)) return;
    await run(
      `retire:${name}`,
      () =>
        fetch(`/api/aliases/${encodeURIComponent(name)}?org_id=${encodeURIComponent(orgId)}`, {
          method: "DELETE"
        }),
      `Alias '${name}' retired.`
    );
  }

  async function toggleHistory(name: string): Promise<void> {
    if (historyFor === name) {
      setHistoryFor(null);
      return;
    }
    setError(null);
    setBusyKey(`history:${name}`);
    try {
      const response = await fetch(
        `/api/aliases/${encodeURIComponent(name)}/revisions?org_id=${encodeURIComponent(orgId)}`
      );
      if (!response.ok) {
        setError(await readApiError(response, "Could not load history."));
        return;
      }
      const payload = (await response.json()) as { revisions: AliasRevision[] };
      setHistory(payload.revisions);
      setHistoryFor(name);
    } finally {
      setBusyKey(null);
    }
  }

  async function rollback(name: string, revisionId: string): Promise<void> {
    await run(
      `rollback:${name}:${revisionId}`,
      () =>
        fetch(`/api/aliases/${encodeURIComponent(name)}/rollback`, {
          body: JSON.stringify({ org_id: orgId, revision_id: revisionId }),
          headers: { "content-type": "application/json" },
          method: "POST"
        }),
      `Alias '${name}' rolled back.`
    );
    setHistoryFor(null);
  }

  const hasModels = models.length > 0;

  return (
    <section className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface lg:max-h-[max(32vh,15rem)]">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 px-[18px] py-3.5">
        <div className="min-w-[240px] max-w-[520px] flex-1">
          {/* A real heading (not a styled span) so heading navigation reaches
              the alias admin surface between the page h1 and the identity
              tier's h2. */}
          <h2 className={clsx("m-0", EYEBROW)}>Named aliases</h2>
          <p className="m-0 mt-1 text-muted text-[13px] leading-relaxed">
            Stable model names your code calls (for example{" "}
            <code className="rounded bg-surface-subtle px-1 py-0.5 text-[12px]">coding</code>) and
            you repoint over time; every repoint is a revision you can roll back to.
          </p>
        </div>
        {hasModels ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className={EYEBROW}>Name</span>
              <input
                aria-label="Alias name"
                className="min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink"
                onChange={(event) => setNewName(event.target.value)}
                placeholder="coding"
                value={newName}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={EYEBROW}>Backing model</span>
              <Dropdown
                aria-label="Backing model"
                onChange={(event) => setNewModel(event.target.value)}
                value={newModel}
              >
                {models.map((model) => (
                  <option key={model.slug} value={model.slug}>
                    {model.display_name} ({model.slug})
                  </option>
                ))}
              </Dropdown>
            </label>
            <Button
              disabled={newName.trim() === "" || busyKey !== null}
              loading={busyKey === "create"}
              onClick={createAlias}
              variant="primary"
            >
              Create
            </Button>
          </div>
        ) : (
          <p className="m-0 max-w-[340px] text-muted text-[13px] leading-relaxed">
            No models are available to point an alias at yet. Add a model with a working provider
            first.
          </p>
        )}
      </div>

      {(error !== null || notice !== null) && (
        <div className="flex flex-col gap-2 px-[18px] pb-3">
          {error !== null && (
            <p className="m-0 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-danger text-[13px]">
              {error}
            </p>
          )}
          {notice !== null && (
            <p className="m-0 rounded-md border border-accent/20 bg-accent-soft px-3 py-2 text-accent text-[13px]">
              {notice}
            </p>
          )}
        </div>
      )}

      {/* The lg min-height keeps the table's scrollport reachable even when a
          wrapped header row plus error/notice banners fill the card's capped
          height; without it this region can shrink to zero and the rows
          become unreachable. */}
      <div className="min-h-0 overflow-x-auto overflow-y-auto border-t border-line lg:min-h-[6rem]">
        {aliases.length === 0 ? (
          <p className="m-0 px-4 py-6 text-center text-muted text-[13px]">
            No named aliases yet. Create one above to give your code a stable model name you can
            repoint later.
          </p>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH}>Alias</th>
                <th className={TH}>Target model</th>
                <th className={TH}>Status</th>
                <th className={TH}>Repoint</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {aliases.map((alias) => (
                <AliasRow
                  key={alias.alias_id}
                  alias={alias}
                  busyKey={busyKey}
                  history={historyFor === alias.name ? history : null}
                  models={models}
                  onHistory={() => toggleHistory(alias.name)}
                  onRepoint={() => repoint(alias.name)}
                  onRepointModelChange={(model) =>
                    setRepointModel((current) => ({ ...current, [alias.name]: model }))
                  }
                  onRetire={() => retire(alias.name)}
                  onRollback={(revisionId) => rollback(alias.name, revisionId)}
                  repointModel={repointModel[alias.name] ?? models[0]?.slug ?? ""}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

type AliasRowProps = {
  alias: NamedAlias;
  busyKey: string | null;
  history: AliasRevision[] | null;
  models: AliasModelOption[];
  onHistory: () => void;
  onRepoint: () => void;
  onRepointModelChange: (model: string) => void;
  onRetire: () => void;
  onRollback: (revisionId: string) => void;
  repointModel: string;
};

function AliasRow({
  alias,
  busyKey,
  history,
  models,
  onHistory,
  onRepoint,
  onRepointModelChange,
  onRetire,
  onRollback,
  repointModel
}: AliasRowProps) {
  const busy = busyKey !== null;
  return (
    <>
      <tr className="border-b border-line/60 align-middle">
        <td className="px-4 py-2 font-medium text-foreground">{alias.name}</td>
        <td className="px-4 py-2 text-ink">
          {alias.target_model_slug ?? <span className="text-muted-2">none</span>}
        </td>
        <td className="px-4 py-2">
          <span
            className={clsx(
              "text-[12px] font-medium",
              alias.active ? "text-accent" : "text-muted-2"
            )}
          >
            {alias.active ? "Active" : "Retired"}
          </span>
        </td>
        <td className="px-4 py-2">
          {models.length > 0 ? (
            <div className="flex items-center gap-2">
              <Dropdown
                aria-label={`Repoint ${alias.name}`}
                onChange={(event) => onRepointModelChange(event.target.value)}
                value={repointModel}
              >
                {models.map((model) => (
                  <option key={model.slug} value={model.slug}>
                    {model.slug}
                  </option>
                ))}
              </Dropdown>
              <Button
                disabled={busy}
                loading={busyKey === `repoint:${alias.name}`}
                onClick={onRepoint}
                size="sm"
              >
                Repoint
              </Button>
            </div>
          ) : null}
        </td>
        <td className="px-4 py-2">
          <div className="flex items-center justify-end gap-2">
            <Button
              disabled={busy}
              loading={busyKey === `history:${alias.name}`}
              onClick={onHistory}
              size="sm"
              variant="ghost"
            >
              {history !== null ? "Hide history" : "History"}
            </Button>
            <Button
              disabled={busy || !alias.active}
              loading={busyKey === `retire:${alias.name}`}
              onClick={onRetire}
              size="sm"
              variant="destructive"
            >
              Retire
            </Button>
          </div>
        </td>
      </tr>
      {history !== null ? (
        <tr className="border-b border-line/60 bg-surface-subtle">
          <td className="px-4 py-3" colSpan={5}>
            <p className={clsx("m-0 mb-2", EYEBROW)}>Repoint history</p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {history.map((revision) => (
                <li
                  key={revision.revision_id}
                  className="flex items-center justify-between gap-3 text-[12px]"
                >
                  <span className="text-ink">
                    {revision.model_slug ?? "unknown model"}
                    {revision.is_current ? (
                      <span className="ml-2 text-accent">current</span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-3 text-muted-2">
                    <LocalDateTime value={revision.created_at} />
                    {revision.is_current ? null : (
                      <Button
                        disabled={busy}
                        loading={busyKey === `rollback:${alias.name}:${revision.revision_id}`}
                        onClick={() => onRollback(revision.revision_id)}
                        size="sm"
                        variant="ghost"
                      >
                        Roll back
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      ) : null}
    </>
  );
}
