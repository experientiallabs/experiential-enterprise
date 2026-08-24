// Display map for org special-attribute labels. The database stores only an
// arbitrary slug (public.org_labels.key); the human text and badge color live
// here, so a new label kind needs no migration. Unknown slugs render with a
// neutral badge and the raw slug uppercased.

export type OrgLabelDisplay = { label: string; className: string };

// YC wears the catalog's amber "star" accent so it reads as a special
// attribute; other kinds start neutral until given their own entry.
const _YC_BADGE =
  "rounded border border-[color:var(--accent-amber)] bg-[color:var(--accent-amber-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--accent-amber)]";

const _NEUTRAL_BADGE =
  "rounded border border-line-strong px-1.5 py-0.5 text-[11px] text-muted";

export const KNOWN_ORG_LABELS: Record<string, OrgLabelDisplay> = {
  yc: { label: "YC", className: _YC_BADGE },
};

/** Known label kinds, for populating the add-label and audience pickers. */
export const KNOWN_ORG_LABEL_KEYS: string[] = Object.keys(KNOWN_ORG_LABELS);

/** Resolve a slug to its display; unknown slugs get a neutral uppercased badge. */
export function orgLabelDisplay(key: string): OrgLabelDisplay {
  return KNOWN_ORG_LABELS[key] ?? { label: key.toUpperCase(), className: _NEUTRAL_BADGE };
}

/** A single org-label badge, shared by the org list, org detail, and promos. */
export function OrgLabelBadge({ labelKey }: { labelKey: string }) {
  const display = orgLabelDisplay(labelKey);
  return <span className={display.className}>{display.label}</span>;
}
