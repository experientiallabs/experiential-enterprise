import { clsx } from "clsx";
import type { ReactNode } from "react";

// Shared prose primitives for the docs content pages (Overview, Quickstart,
// Core loop, Models, Errors, API reference, and the admin-only internal
// reference). Every page renders through these so the whole section reads as
// one publication: one heading rhythm, one table style, one callout, one
// inline-code treatment. The classes mirror the scaffold's Overview page, so
// there is exactly one source of truth for the docs body's look. Table-first
// per the design language (Contract 6).

/** A titled section. The id is the anchor the on-this-page rail links to. */
export function DocsSection({
  id,
  title,
  children
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2
        className="mb-3 mt-10 text-[17px] font-semibold tracking-tight text-ink"
        id={id}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A subsection heading inside a section (no rail entry). */
export function DocsSubheading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 mt-7 text-[14px] font-semibold tracking-tight text-ink">
      {children}
    </h3>
  );
}

/** One body paragraph. */
export function Prose({ children }: { children: ReactNode }) {
  return <p className="mb-4 mt-0 text-[13.5px] leading-relaxed text-muted">{children}</p>;
}

/** A bulleted list of short points. */
export function DocsList({ children }: { children: ReactNode }) {
  return (
    <ul className="my-4 flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] leading-relaxed text-muted marker:text-muted-2">
      {children}
    </ul>
  );
}

/** A numbered list of steps. */
export function DocsSteps({ children }: { children: ReactNode }) {
  return (
    <ol className="my-4 flex list-decimal flex-col gap-2 pl-5 text-[13.5px] leading-relaxed text-muted marker:text-muted-2">
      {children}
    </ol>
  );
}

/** Inline monospace for identifiers, paths, and literals. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[12.5px] text-ink">{children}</code>;
}

export type CalloutTone = "note" | "warning";

const CALLOUT_STYLES: Record<CalloutTone, string> = {
  note: "border-line bg-surface",
  warning: "border-[color:var(--warning)] bg-[color:var(--warning-soft)]"
};

/** A boxed aside: a note, or a warning about a sharp edge an agent must code against. */
export function Callout({ tone = "note", children }: { tone?: CalloutTone; children: ReactNode }) {
  return (
    <div
      className={clsx(
        "my-4 rounded-md border px-3.5 py-3 text-[13px] leading-relaxed text-muted",
        CALLOUT_STYLES[tone]
      )}
    >
      {children}
    </div>
  );
}

export type DocsTableColumn = {
  key: string;
  header: string;
  /** Render this column's cells in monospace (codes, endpoints). */
  mono?: boolean;
};

export type DocsTableRow = Record<string, ReactNode>;

/** The docs table: thin lines, dense, mono where a cell is a literal. */
export function DocsTable({
  columns,
  rows
}: {
  columns: readonly DocsTableColumn[];
  rows: readonly DocsTableRow[];
}) {
  return (
    <div className="my-4 overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-left text-[12.5px]">
        <thead>
          <tr className="border-b border-line bg-surface-subtle">
            {columns.map((column) => (
              <th
                key={column.key}
                className="px-3 py-2 font-medium text-muted-2"
                scope="col"
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-line last:border-0">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={clsx(
                    "px-3 py-2 align-top leading-relaxed text-muted",
                    column.mono && "whitespace-nowrap font-mono text-[12px] text-ink"
                  )}
                >
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
