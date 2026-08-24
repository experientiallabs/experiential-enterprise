"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { GripVertical, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { readApiError } from "@/components/world-models/wm-client";
import type { RecommendedModel } from "@/lib/recommended-models/types";

const INPUT_CLASS =
  "w-full min-h-[34px] rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-muted-2 focus:outline-none focus:border-[#bdbdbd]";
const LABEL_CLASS =
  "mb-1.5 block text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/25";

/** One public catalog model the card can add to the recommended set. */
export type RecommendedModelOption = {
  slug: string;
  display_name: string;
};

type RecommendedModelsCardProps = {
  /** The current set in rank order, from GET /api/admin/recommended-models. */
  recommended: RecommendedModel[];
  /** The public catalog: the add-by-slug validator and display-name source. */
  models: RecommendedModelOption[];
};

/**
 * The admin Recommended card: the ordered set of starred, front-of-catalog
 * models (models.preferred_rank) as an editable list. Drag a row to reorder
 * (the same idiom as the waterfall in ways-to-use; the focusable grip also
 * moves the row with the arrow keys), add any public catalog
 * model by slug, remove, then save: one PUT of the full ordered list assigns
 * ranks 0..N-1 and unpins every other public model atomically. The set cannot
 * be saved empty (the seed treats an unranked catalog as fresh and would
 * restore the defaults). Platform-admin gated by the admin layout above.
 */
export function RecommendedModelsCard({ recommended, models }: RecommendedModelsCardProps) {
  const router = useRouter();
  const initial = useMemo(() => recommended.map((model) => model.slug), [recommended]);
  const [draft, setDraft] = useState<string[]>(initial);
  const [saved, setSaved] = useState<string[]>(initial);
  const [dragSlug, setDragSlug] = useState<string | null>(null);
  const [slugInput, setSlugInput] = useState("");
  const [slugError, setSlugError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const displayNames = useMemo(() => {
    const names = new Map(models.map((model) => [model.slug, model.display_name]));
    for (const model of recommended) {
      if (!names.has(model.slug)) {
        names.set(model.slug, model.display_name);
      }
    }
    return names;
  }, [models, recommended]);

  const knownSlugs = useMemo(() => new Set(models.map((model) => model.slug)), [models]);

  const dirty = draft.length !== saved.length || draft.some((slug, i) => slug !== saved[i]);

  function drop(targetSlug: string) {
    if (dragSlug === null || dragSlug === targetSlug) {
      setDragSlug(null);
      return;
    }
    setDraft((current) => {
      const next = [...current];
      const from = next.indexOf(dragSlug);
      const to = next.indexOf(targetSlug);
      if (from === -1 || to === -1) {
        return current;
      }
      next.splice(from, 1);
      next.splice(to, 0, dragSlug);
      return next;
    });
    setDragSlug(null);
  }

  // Keyboard path for the grip: arrow keys move the focused row one step, so
  // reordering never requires a pointer.
  function nudge(slug: string, delta: number) {
    setDraft((current) => {
      const from = current.indexOf(slug);
      const to = from + delta;
      if (from === -1 || to < 0 || to >= current.length) {
        return current;
      }
      const next = [...current];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
  }

  function addSlug() {
    const slug = slugInput.trim();
    if (slug === "") {
      return;
    }
    if (!knownSlugs.has(slug)) {
      setSlugError(`"${slug}" is not a catalog model slug.`);
      return;
    }
    if (draft.includes(slug)) {
      setSlugError(`"${slug}" is already in the recommended set.`);
      return;
    }
    setSlugError(null);
    setSlugInput("");
    setDraft((current) => [...current, slug]);
  }

  async function save() {
    if (!dirty || draft.length === 0 || isSaving) {
      return;
    }
    setError(null);
    setNotice(null);
    setIsSaving(true);
    try {
      const response = await fetch("/api/admin/recommended-models", {
        body: JSON.stringify({ slugs: draft }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      if (!response.ok) {
        setError(await readApiError(response, "Unable to save the recommended set."));
        return;
      }
      setSaved(draft);
      setNotice("Recommended set saved.");
      router.refresh();
    } catch (thrown) {
      // A thrown fetch (network drop, aborted request) would otherwise reset
      // the saving state with no feedback, leaving the admin unsure whether
      // the order saved. Surface it so they can retry.
      setError(
        `Saving the recommended set failed (${
          thrown instanceof Error ? thrown.message : "network error"
        }). Retry.`
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <ol className="m-0 flex list-none flex-col p-0">
          {draft.length === 0 ? (
            <p className="m-0 py-1.5 text-[13px] text-muted">
              No recommended models. Add at least one: an empty set cannot be saved.
            </p>
          ) : (
            draft.map((slug, index) => (
              <li
                className={clsx(
                  "flex items-center gap-3 border-b border-line py-1.5 transition-opacity last:border-b-0",
                  dragSlug === slug && "opacity-60"
                )}
                draggable={!isSaving}
                key={slug}
                onDragEnd={() => setDragSlug(null)}
                onDragOver={(event) => {
                  if (!isSaving) {
                    event.preventDefault();
                  }
                }}
                onDragStart={() => setDragSlug(slug)}
                onDrop={(event) => {
                  event.preventDefault();
                  drop(slug);
                }}
              >
                <button
                  aria-label={`Reorder ${slug}`}
                  className="shrink-0 cursor-grab rounded-sm text-muted-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent active:cursor-grabbing"
                  disabled={isSaving}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault();
                      nudge(slug, event.key === "ArrowUp" ? -1 : 1);
                    }
                  }}
                  type="button"
                >
                  <GripVertical aria-hidden size={15} strokeWidth={1.8} />
                </button>
                <span className="w-5 shrink-0 text-right font-mono text-[11px] text-ink-faint">
                  {index + 1}
                </span>
                <span className="min-w-0 truncate text-[13px] text-ink">
                  {displayNames.get(slug) ?? slug}
                </span>
                <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-2">
                  {slug}
                </span>
                <button
                  aria-label={`Remove ${slug}`}
                  disabled={isSaving}
                  className="ml-auto cursor-pointer rounded-sm p-1 text-muted transition-colors hover:bg-surface-subtle hover:text-danger"
                  onClick={() => setDraft((current) => current.filter((s) => s !== slug))}
                  type="button"
                >
                  <X size={13} strokeWidth={1.8} />
                </button>
              </li>
            ))
          )}
        </ol>

        <div>
          <label className={LABEL_CLASS} htmlFor="recommended-slug">
            Add a model by slug
          </label>
          <div className="flex max-w-[420px] items-center gap-2">
            <input
              id="recommended-slug"
              className={INPUT_CLASS}
              type="text"
              placeholder="qwen3.8-27b"
              list="recommended-slug-options"
              value={slugInput}
              disabled={isSaving}
              onChange={(event) => {
                setSlugInput(event.target.value);
                setSlugError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addSlug();
                }
              }}
            />
            <datalist id="recommended-slug-options">
              {models
                .filter((model) => !draft.includes(model.slug))
                .map((model) => (
                  <option key={model.slug} label={model.display_name} value={model.slug} />
                ))}
            </datalist>
            <Button disabled={isSaving} onClick={addSlug} type="button" variant="ghost">
              <Plus aria-hidden size={14} strokeWidth={2} />
              Add
            </Button>
          </div>
          {slugError && <p className="m-0 mt-1.5 text-[12.5px] text-danger">{slugError}</p>}
        </div>

        <div className="flex items-center gap-3">
          <Button
            disabled={!dirty || draft.length === 0 || isSaving}
            onClick={save}
            type="button"
            variant="primary"
          >
            {isSaving ? "Saving..." : "Save order"}
          </Button>
          <p className="m-0 text-[12px] text-muted-2">
            Saving replaces the whole set. Unlisted models lose their star.
          </p>
        </div>
        {error && <p className="m-0 text-[13px] text-danger">{error}</p>}
        {notice && <p className="m-0 text-[13px] text-muted">{notice}</p>}
      </div>
    </Card>
  );
}
