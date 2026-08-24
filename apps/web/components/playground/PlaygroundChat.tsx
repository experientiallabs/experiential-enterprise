"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { Paperclip, X } from "lucide-react";

import { ModalityIcons } from "@/components/models-catalog/badges";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { COMPARE_LIMIT } from "@/components/models-catalog/filtering";
import { formatTokenCount } from "@/lib/models-catalog/format";
import { formatPerCallUsd } from "@/lib/money";
import {
  streamPlaygroundChat,
  type PlaygroundChatRequest
} from "@/lib/playground/dispatch";
import {
  buildRequestParams,
  emptyParamState,
  estimateResponseCostUsd,
  supportedAttachmentModalities,
  type AttachmentModality
} from "@/lib/playground/model-params";
import type { CatalogEntry } from "@/lib/models-catalog/types";

import { ModelPicker } from "./ModelPicker";
import { ParamsRail } from "./ParamsRail";

type PlaygroundChatProps = {
  models: CatalogEntry[];
  orgId: string;
  /**
   * Models preselected by the URL (?model= or ?models=a,b,c). Unknown or
   * unplayable slugs are dropped; more than COMPARE_LIMIT are truncated; an
   * empty result falls back to the catalog's first model.
   */
  initialModelSlugs: string[];
};

/** A staged attachment: a data URL the composer will send as a content part. */
type Attachment = {
  id: string;
  name: string;
  kind: AttachmentModality;
  dataUrl: string;
};

/** The gateway's measured usage for one response. */
type ResponseUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
};

/** One rendered chat turn; assistant turns also carry their measured usage. */
type Turn = {
  role: "user" | "assistant";
  content: string;
  attachments: Attachment[];
  usage: ResponseUsage | null;
  error: string | null;
};

/**
 * One model's column: its own transcript, streamed and errored independently
 * of its siblings. `slug` is the identity — a model appears at most once.
 */
type Pane = {
  slug: string;
  turns: Turn[];
};

// Composer guards, mirroring the route's bounds so the UI refuses oversized
// input before spending a request.
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 4_000_000;

// Tailwind needs the class literals present at build time, so the pane grid
// maps count -> class instead of interpolating.
const PANE_GRID: Record<number, string> = {
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4"
};

/** OpenAI content part shapes; forwarded verbatim to /v1. */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

/** Build one message's content: a plain string, or parts when attached. */
function messageContent(text: string, attachments: Attachment[]): string | ContentPart[] {
  if (attachments.length === 0) {
    return text;
  }
  const parts: ContentPart[] = [];
  if (text !== "") {
    parts.push({ type: "text", text });
  }
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      parts.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
    } else {
      parts.push({
        type: "file",
        file: { filename: attachment.name, file_data: attachment.dataUrl }
      });
    }
  }
  return parts;
}

/** Read a File into a data URL, or reject on read failure. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

/** Known, deduped, capped panes from raw URL slugs. */
function initialPanes(slugs: string[], models: CatalogEntry[]): Pane[] {
  const known = new Set(models.map((entry) => entry.model.slug));
  const deduped = [...new Set(slugs)].filter((slug) => known.has(slug)).slice(0, COMPARE_LIMIT);
  const chosen = deduped.length > 0 ? deduped : models[0] ? [models[0].model.slug] : [];
  return chosen.map((slug) => ({ slug, turns: [] }));
}

/**
 * The playground: chat with any gateway model over its real /v1 serving path,
 * with a parameter rail that adapts to what the selected model supports and
 * per-response cost, tokens, and latency from the gateway's own usage. There
 * are no routers or optimized-endpoint concepts — the catalog model IS the
 * thing you talk to.
 *
 * With more than one model (?models=a,b or the Add model control) the page
 * becomes a comparison: one composer, one submit, every model answering the
 * same prompt in its own independently streamed column. A slow or failing
 * model never blocks its siblings.
 */
export function PlaygroundChat({ models, orgId, initialModelSlugs }: PlaygroundChatProps) {
  const [panes, setPanes] = useState<Pane[]>(() => initialPanes(initialModelSlugs, models));
  const [paramState, setParamState] = useState(emptyParamState);
  const [composer, setComposer] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // One controller per streaming pane, keyed by slug: Stop aborts them all,
  // and removing a pane aborts just its own request — the route only stops
  // its upstream (credit-spending) call when the client request aborts, so a
  // pane deleted mid-stream must not keep paying invisibly.
  const abortersRef = useRef(new Map<string, AbortController>());
  const streamingRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isCompare = panes.length > 1;

  const entryBySlug = useMemo(
    () => new Map(models.map((entry) => [entry.model.slug, entry])),
    [models]
  );
  const paneEntries = panes.map((pane) => entryBySlug.get(pane.slug) ?? null);

  // Single-model surfaces (params rail, attachments, the control-bar shape
  // line) key off the one selected entry; in compare mode they are absent.
  const selectedEntry = isCompare ? null : (paneEntries[0] ?? null);
  const attachmentModalities = selectedEntry
    ? supportedAttachmentModalities(selectedEntry.model)
    : [];

  // Abort every in-flight stream on unmount.
  useEffect(() => {
    const aborters = abortersRef.current;
    return () => {
      for (const controller of aborters.values()) {
        controller.abort();
      }
    };
  }, []);

  function abortAll() {
    for (const controller of abortersRef.current.values()) {
      controller.abort();
    }
  }

  /**
   * Mirror the pane set to the URL in place — history.replaceState, never a
   * router navigation (house convention: under force-dynamic a router.replace
   * re-runs the whole server render per click). One model keeps the historic
   * ?model= shape so existing deep links and bookmarks stay canonical; two or
   * more write ?models=a,b.
   */
  function syncUrl(slugs: string[]) {
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("model");
    url.searchParams.delete("models");
    if (slugs.length === 1) {
      url.searchParams.set("model", slugs[0]);
    } else if (slugs.length > 1) {
      url.searchParams.set("models", slugs.join(","));
    }
    window.history.replaceState(null, "", url.toString());
  }

  function applyPanes(next: Pane[]) {
    setPanes(next);
    setNotice(null);
    syncUrl(next.map((pane) => pane.slug));
  }

  function selectModel(paneIndex: number, slug: string) {
    if (panes.some((pane, index) => index !== paneIndex && pane.slug === slug)) {
      return;
    }
    // Attachments staged for a model that the next one may not accept are
    // cleared; the transcript survives the swap, as it always has.
    setAttachments([]);
    applyPanes(panes.map((pane, index) => (index === paneIndex ? { ...pane, slug } : pane)));
  }

  function addPane(slug: string) {
    if (panes.length >= COMPARE_LIMIT || panes.some((pane) => pane.slug === slug)) {
      return;
    }
    setAttachments([]);
    applyPanes([...panes, { slug, turns: [] }]);
  }

  function removePane(slug: string) {
    if (panes.length <= 1) {
      return;
    }
    // A removed pane's stream stops now, not when the whole send finishes.
    abortersRef.current.get(slug)?.abort();
    applyPanes(panes.filter((pane) => pane.slug !== slug));
  }

  function updateLastAssistant(slug: string, map: (turn: Turn) => Turn) {
    setPanes((prev) =>
      prev.map((pane) => {
        if (pane.slug !== slug || pane.turns.length === 0) {
          return pane;
        }
        const turns = [...pane.turns];
        turns[turns.length - 1] = map(turns[turns.length - 1]);
        return { ...pane, turns };
      })
    );
  }

  async function addFiles(files: FileList | null) {
    if (files === null || selectedEntry === null) {
      return;
    }
    const staged: Attachment[] = [];
    for (const file of Array.from(files)) {
      if (attachments.length + staged.length >= MAX_ATTACHMENTS) {
        setNotice(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setNotice(`${file.name} is larger than 4 MB.`);
        continue;
      }
      const isImage = file.type.startsWith("image/");
      if (!isImage && !attachmentModalities.includes("pdf")) {
        // The picker's accept list is advisory only; a model without PDF
        // support must not receive a file part it will 400 on.
        setNotice(`${file.name}: this model accepts image attachments only.`);
        continue;
      }
      try {
        staged.push({
          id: `${file.name}-${crypto.randomUUID()}`,
          name: file.name,
          // A non-image file is always a PDF part; sending it as image_url
          // (which the old modality-derived default did) 400s at the provider.
          kind: isImage ? "image" : "pdf",
          dataUrl: await readAsDataUrl(file)
        });
      } catch {
        setNotice(`${file.name} could not be read.`);
      }
    }
    if (staged.length > 0) {
      setAttachments((prev) => [...prev, ...staged]);
    }
  }

  function submit() {
    // No login gate here: the page's server fetch (resolveActiveOrg) throws
    // AuthRequiredError for a signed-out visitor, so this component only ever
    // mounts for an authenticated session with a real orgId to bill against.
    void send();
  }

  /** Run one pane's streamed exchange; errors land in that pane only. */
  async function runPane(
    slug: string,
    body: PlaygroundChatRequest,
    signal: AbortSignal
  ): Promise<void> {
    try {
      for await (const event of streamPlaygroundChat(body, signal)) {
        switch (event.type) {
          case "delta":
            updateLastAssistant(slug, (turn) => ({ ...turn, content: turn.content + event.text }));
            break;
          case "usage":
            updateLastAssistant(slug, (turn) => ({
              ...turn,
              usage: {
                promptTokens: event.promptTokens,
                completionTokens: event.completionTokens,
                latencyMs: event.latencyMs
              }
            }));
            break;
          case "error":
            updateLastAssistant(slug, (turn) => ({ ...turn, error: event.message }));
            break;
          case "done":
            break;
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        updateLastAssistant(slug, (turn) => ({
          ...turn,
          error: error instanceof Error ? error.message : "The response could not be completed."
        }));
      }
    }
  }

  async function send() {
    const trimmed = composer.trim();
    if ((trimmed === "" && attachments.length === 0) || streamingRef.current) {
      return;
    }
    if (panes.length === 0) {
      return;
    }
    // Compare mode always sends provider defaults: the rail is a single-model
    // surface, and a shared setting one model rejects would poison the fan-out.
    const activeParams = isCompare ? emptyParamState() : paramState;
    setNotice(null);
    streamingRef.current = true;

    const outgoing = isCompare ? [] : attachments;
    const userTurn: Turn = {
      role: "user",
      content: trimmed,
      attachments: outgoing,
      usage: null,
      error: null
    };

    // Each pane extends its own history with the shared user turn plus an
    // assistant placeholder, then streams into that placeholder.
    const requests = panes.map((pane) => {
      const entry = entryBySlug.get(pane.slug) ?? null;
      const history = [...pane.turns, userTurn];
      const wireMessages = history.map((turn) => ({
        role: turn.role,
        content: messageContent(turn.content, turn.attachments)
      }));
      const built =
        entry === null
          ? { ok: false as const, error: "This model is no longer in the catalog." }
          : buildRequestParams(entry.model, activeParams);
      return { slug: pane.slug, wireMessages, built };
    });

    // Single-model parameter mistakes stay a pre-flight notice, exactly as
    // before, instead of burning a request.
    if (!isCompare && requests[0] && !requests[0].built.ok) {
      setNotice(requests[0].built.error);
      streamingRef.current = false;
      return;
    }

    // A pane whose request could not even be built (model gone, bad params in
    // compare mode) shows its error immediately; it is excluded from the fan-out.
    const errorBySlug = new Map(
      requests.flatMap((request) =>
        request.built.ok ? [] : [[request.slug, request.built.error] as const]
      )
    );
    setPanes((prev) =>
      prev.map((pane) => ({
        ...pane,
        turns: [
          ...pane.turns,
          userTurn,
          {
            role: "assistant",
            content: "",
            attachments: [],
            usage: null,
            error: errorBySlug.get(pane.slug) ?? null
          }
        ]
      }))
    );
    setComposer("");
    setAttachments([]);

    setIsStreaming(true);
    try {
      // Fan out concurrently; allSettled so one pane's failure never touches
      // the others (runPane also catches its own errors). Each pane gets its
      // own controller so removing it cancels only its request.
      await Promise.allSettled(
        requests
          .filter((request) => request.built.ok)
          .map((request) => {
            const controller = new AbortController();
            abortersRef.current.set(request.slug, controller);
            return runPane(
              request.slug,
              {
                model: request.slug,
                orgId,
                messages: request.wireMessages,
                params: request.built.ok ? request.built.params : {}
              },
              controller.signal
            ).finally(() => {
              abortersRef.current.delete(request.slug);
            });
          })
      );
    } finally {
      streamingRef.current = false;
      setIsStreaming(false);
    }
  }

  if (models.length === 0) {
    return (
      <EmptyState
        title="No models in the catalog yet"
        body="Once models are published to the gateway catalog they appear here, ready to chat with."
      />
    );
  }

  const lastUsage =
    [...(panes[0]?.turns ?? [])].reverse().find((turn) => turn.usage !== null)?.usage ?? null;
  const addable = models.filter((entry) => !panes.some((pane) => pane.slug === entry.model.slug));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Control bar: the model choice (single) or the pane count (compare),
          and the Add model door into side-by-side comparison. */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-3">
        {!isCompare ? (
          <>
            <ModelPicker
              models={models}
              onSelect={(slug) => selectModel(0, slug)}
              selectedSlug={panes[0]?.slug ?? null}
            />
            {selectedEntry !== null ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
                <ModalityIcons modalities={selectedEntry.model.input_modalities} />
                <span>
                  <span className="text-ink-faint">context</span>{" "}
                  {formatTokenCount(selectedEntry.model.context_window)}
                </span>
                <span>
                  <span className="text-ink-faint">max out</span>{" "}
                  {formatTokenCount(selectedEntry.model.max_output_tokens)}
                </span>
              </div>
            ) : null}
          </>
        ) : (
          <span className="text-[12px] text-muted">
            Comparing {panes.length} models. One prompt, every reply side by side.
          </span>
        )}
        {panes.length < COMPARE_LIMIT && addable.length > 0 ? (
          <div className="ml-auto">
            <ModelPicker
              models={addable}
              onSelect={addPane}
              selectedSlug={null}
              triggerLabel="Add model"
              triggerClassName="min-w-0"
            />
          </div>
        ) : null}
      </div>

      <div
        className={clsx(
          "min-h-0 flex-1",
          isCompare
            ? clsx("grid grid-cols-1 gap-3 overflow-y-auto lg:overflow-visible", PANE_GRID[panes.length])
            : "grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]"
        )}
      >
        {isCompare ? (
          panes.map((pane, index) => (
            <PaneColumn
              entry={paneEntries[index]}
              key={pane.slug}
              onRemove={() => removePane(pane.slug)}
              pane={pane}
              removable={panes.length > 1}
            />
          ))
        ) : (
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <PaneTranscript
              emptyHint={`Send a message to ${selectedEntry?.model.display_name ?? "the selected model"}. The reply streams from the live gateway, metered like any other traffic.`}
              entry={selectedEntry}
              turns={panes[0]?.turns ?? []}
            />
          </div>
        )}
        {/* The params rail is a single-model surface; compare mode sends
            provider defaults, so the slot is intentionally empty there. */}
        {!isCompare ? (
          <ParamsRail
            entry={selectedEntry}
            lastUsage={lastUsage}
            onChange={setParamState}
            state={paramState}
          />
        ) : null}
      </div>

      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] text-ink-soft"
              key={attachment.id}
            >
              <Paperclip aria-hidden size={11} strokeWidth={1.8} />
              {attachment.name}
              <button
                aria-label={`Remove ${attachment.name}`}
                className="cursor-pointer border-0 bg-transparent p-0 text-muted-2 hover:text-ink"
                onClick={() =>
                  setAttachments((prev) => prev.filter((item) => item.id !== attachment.id))
                }
                type="button"
              >
                <X aria-hidden size={12} strokeWidth={1.8} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {notice !== null ? (
        <p className="m-0 text-[12px] text-warning" role="status">
          {notice}
        </p>
      ) : null}

      <form
        className="flex shrink-0 items-end gap-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {/* Attachments are single-model: panes differ in what they accept, and
            a part one model 400s on must not fan out to all of them. */}
        {!isCompare && attachmentModalities.length > 0 ? (
          <>
            <input
              accept={attachmentModalities
                .map((modality) => (modality === "image" ? "image/*" : "application/pdf"))
                .join(",")}
              className="hidden"
              multiple
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
            <Button
              aria-label="Attach a file"
              className="min-h-[38px]"
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              <Paperclip aria-hidden size={14} strokeWidth={1.8} />
            </Button>
          </>
        ) : null}
        <textarea
          aria-label="Message"
          className="min-h-[38px] flex-1 resize-y rounded-md border border-line-strong bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink outline-0 focus:border-[#bdbdbd]"
          onChange={(event) => setComposer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={isCompare ? `Send to ${panes.length} models` : "Send a message"}
          ref={composerRef}
          rows={1}
          value={composer}
        />
        {isStreaming ? (
          <Button onClick={abortAll} type="button">
            Stop
          </Button>
        ) : (
          <Button
            disabled={composer.trim() === "" && attachments.length === 0}
            type="submit"
            variant="primary"
          >
            Send
          </Button>
        )}
      </form>
    </div>
  );
}

/** One compare column: header (model, remove) over its own transcript. */
function PaneColumn({
  pane,
  entry,
  removable,
  onRemove
}: {
  pane: Pane;
  entry: CatalogEntry | null;
  removable: boolean;
  onRemove: () => void;
}) {
  return (
    <section
      className="flex min-h-[240px] min-w-0 flex-col gap-2 lg:min-h-0"
      data-testid="playground-pane"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-0.5">
        <span className="truncate text-[13px] font-semibold text-ink">
          {entry?.model.display_name ?? pane.slug}
        </span>
        {removable ? (
          <button
            aria-label={`Remove ${entry?.model.display_name ?? pane.slug}`}
            className="cursor-pointer border-0 bg-transparent p-0 text-muted-2 hover:text-ink"
            onClick={onRemove}
            type="button"
          >
            <X aria-hidden size={14} strokeWidth={1.8} />
          </button>
        ) : null}
      </div>
      <PaneTranscript
        emptyHint={`${entry?.model.display_name ?? pane.slug} answers here.`}
        entry={entry}
        turns={pane.turns}
      />
    </section>
  );
}

/** A transcript surface, pinned to its latest turn as it streams. */
function PaneTranscript({
  turns,
  entry,
  emptyHint
}: {
  turns: Turn[];
  entry: CatalogEntry | null;
  emptyHint: string;
}) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg border border-line bg-surface"
      data-testid="playground-transcript"
      ref={transcriptRef}
    >
      {turns.length === 0 ? (
        <div className="grid flex-1 place-items-center p-6 text-center">
          <p className="m-0 max-w-[420px] text-[13px] leading-relaxed text-muted">{emptyHint}</p>
        </div>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-3 p-4">
          {turns.map((turn, index) => (
            <li
              className={clsx(
                "flex flex-col gap-1.5",
                turn.role === "user" ? "items-end" : "items-start"
              )}
              key={index}
            >
              <div
                className={clsx(
                  "max-w-[85%] rounded-lg border px-3.5 py-2.5",
                  turn.role === "user"
                    ? "border-line-strong bg-surface-subtle"
                    : "border-line bg-surface"
                )}
              >
                {turn.attachments.length > 0 ? (
                  <div className="mb-1.5 flex flex-wrap gap-1.5">
                    {turn.attachments.map((attachment) => (
                      <span
                        className="inline-flex items-center gap-1 rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-soft"
                        key={attachment.id}
                      >
                        <Paperclip aria-hidden size={10} strokeWidth={1.8} />
                        {attachment.name}
                      </span>
                    ))}
                  </div>
                ) : null}
                <p className="m-0 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">
                  {turn.content}
                  {turn.role === "assistant" && turn.content === "" && turn.error === null ? (
                    <span className="text-muted-2">…</span>
                  ) : null}
                </p>
                {turn.error !== null ? (
                  <p className="mb-0 mt-2 text-[12px] leading-relaxed text-danger" role="alert">
                    {turn.error}
                  </p>
                ) : null}
                {turn.usage !== null ? <TurnUsage entry={entry} usage={turn.usage} /> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Compact evidence under an assistant reply: tokens, cost, latency. */
function TurnUsage({ entry, usage }: { entry: CatalogEntry | null; usage: ResponseUsage }) {
  const cost =
    entry === null
      ? null
      : estimateResponseCostUsd(entry, usage.promptTokens, usage.completionTokens);
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-line pt-2 text-[11px] text-muted-2"
      data-testid="turn-usage"
    >
      {usage.promptTokens !== null && usage.completionTokens !== null ? (
        <span>
          {usage.promptTokens.toLocaleString("en-US")} in /{" "}
          {usage.completionTokens.toLocaleString("en-US")} out
        </span>
      ) : null}
      <span>{formatPerCallUsd(cost)}</span>
      <span>{usage.latencyMs.toLocaleString("en-US")} ms</span>
    </div>
  );
}
