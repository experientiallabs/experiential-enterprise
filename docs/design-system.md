# Experiential Labs Design System

This is the branding and design contract for the platform web app. If a surface
disagrees with this document, the surface is wrong.

**Direction:** Vercel / Linear / Notion / Apple. Minimal, tasteful, information-dense.
Thin hairlines instead of shadows, quiet hover states, generous whitespace only where it
buys legibility. On brand with the marketing site: white/off-white surfaces, near-black
ink, one green accent. Cleaner and more composed than a default dashboard, but never at
the cost of density — pages should carry all the relevant information.

## Tokens

All color, radius, and font tokens are CSS variables defined in
`apps/web/app/globals.css` and mapped to Tailwind utilities in
`apps/web/tailwind.config.ts`. Use the Tailwind utility (or `var(--token)`) — never a
raw hex value in component code. Token names are a stable contract: other code reads
them, so do not rename them.

### Neutrals

| Token | Value | Tailwind | Use |
|---|---|---|---|
| `--background` | `#fafafa` | `bg-background` | App/page background |
| `--surface` | `#ffffff` | `bg-surface` | Cards, panels, inputs |
| `--surface-subtle` | `#f5f5f5` | `bg-surface-subtle` | Quiet fills: ghost-button hover, skeleton base |
| `--surface-sunk` | mix of `--line`/white | `bg-surface-sunk` | Inset/sunken panel fills |
| `--ink` / `--foreground` | `#0a0a0a` | `text-ink` / `text-foreground` | Primary text (aliases; both exist for utility ergonomics) |
| `--ink-soft` | 62% ink | `text-ink-soft` | Secondary text on dense surfaces |
| `--ink-faint` | `#8a8a8a` | `text-ink-faint` | Faint metadata; also the `.mono-label` color |
| `--muted` | `#737373` | `text-muted` | Standard secondary text |
| `--muted-2` | `#a3a3a3` | `text-muted-2` | Tertiary text, placeholders |
| `--line` | `#ededed` | `border-line` | Default hairline border and divider |
| `--line-strong` | `#e0e0e0` | `border-line-strong` | Control borders (buttons, selects), emphasized dividers |
| `--hover` | `#efefef` | `bg-hover` | Row/item hover fill |
| `--active` | `#f1f1f1` | `bg-active` | Pressed/active fill |

### Accent and status

| Token | Value | Tailwind | Use |
|---|---|---|---|
| `--accent` | `#168a49` | `bg-accent` / `text-accent` | THE brand green (matches the marketing site): selection, active nav, focus, primary CTAs |
| `--accent-soft` | `#eafaf0` | `bg-accent-soft` | Soft green fill behind accent content |
| `--success` / `--success-soft` | `#22a050` / `#f0fdf4` | `text-success` / `bg-success-soft` | Positive outcomes |
| `--danger` / `--danger-soft` | `#dc3c3c` / `#fef2f2` | `text-danger` / `bg-danger-soft` | Failures, destructive actions, error text |
| `--warning` / `--warning-soft` | `#b45309` / `#fff9ea` | `text-warning` / `bg-warning-soft` | Invalid / needs-attention states |
| `--purple` / `--purple-soft` | `#7850c8` / `#faf5ff` | `text-purple` / `bg-purple-soft` | Speculative/future states (chips) |
| `--accent-amber` | `#f5a623` | `fill-accent-amber` | Decorative gold only — the recommended-model star fill. Not a status color; use `--warning` for warnings |

One accent. The green is the only interactive brand color; do not introduce per-feature
accent colors. Status colors carry meaning (see chip tones) and are never decorative.

### Radii

`--radius-sm` 4px, `--radius-md` 6px, `--radius-lg` 8px — mapped to `rounded-sm/md/lg`.
Small controls use `md`, cards and tiles use `lg`, tiny inline elements use `sm`. Chips
are the one `rounded-full` exception.

### Typography

Geist Sans (`--font-geist-sans`, `font-sans`) for everything; Geist Mono
(`--font-geist-mono`, `font-mono`) for identifiers, keys, numbers-as-data, and labels.
Both are loaded in `apps/web/app/layout.tsx`.

Scale in practice: page titles ~`text-sm`–`text-base` semibold, body and controls
`text-sm`/`text-[13px]`, metadata `text-xs`/`text-[11px]`. Information density comes
from small, consistent type on hairline-separated rows — not from cramming.

**`.mono-label`** (defined in `globals.css`) is the house eyebrow: 10px uppercase
tracked Geist Mono in `--ink-faint`. Use it for section eyebrows, stat labels, and
grouped-list headers. It is the standard way to title a dense block without a heavy
heading.

### Dark signin theme

`--onboard-*` tokens (`bg/surface/text/muted/border/input-bg`, Tailwind `onboard-*`)
are the dark theme used by `/signin` (`apps/web/app/signin/`). They stay scoped to that
surface; the product app is light-only. The `inverse` / `inverse-outline` Button
variants exist for these dark surfaces.

## Lines, spacing, layout

- **Hairlines everywhere, shadows almost nowhere.** Structure comes from 1px
  `border-line` borders and dividers; use `border-line-strong` for interactive control
  outlines. No drop shadows on cards; elevation is reserved for overlays
  (dropdown/tooltip/modal).
- Cards (`components/ui/Card.tsx`): 1px `--line` border, `--radius-lg`, `--surface`
  fill, 18px padding. Repeated object groups render as cards; step-level or row-level
  data renders as hairline-separated rows or compact tables.
- Hover states are quiet: `bg-hover` or `bg-surface-subtle` fills, no color shifts,
  no transforms.
- Page shells fill the dynamic viewport. Use percentages, flex/grid growth, `clamp()`,
  container queries, and dvh units for structure; exact pixel dimensions are for small
  controls and deliberate content bounds only.
- Skeletons (`Shimmer`, `SkeletonChip` in `apps/web/components/ui/`) stand in for every
  async surface; `ErrorTile` covers failure states; `EmptyState` is the standard
  empty/stub body. Timestamps render through `LocalDateTime` so server and hydration
  output agree.
- Each primary surface ships a page-shaped `loading.tsx` that mirrors its own
  geometry (`Shimmer`-built, `h-full min-h-0` to fill the viewport and scroll
  inside its own frame) rather than falling back to the generic group card grid —
  so the route fallback and the surface's own in-page shimmers read as one
  treatment, never two different skeletons for the same page.

## Icons

Lucide (`lucide-react`) only for UI icons. The one exception is third-party
BRAND marks on the catalog surfaces, centralized in
`components/models-catalog/model-icon.tsx`: simple-icons paths rendered
monochrome in ink. Two registries share one mark vocabulary and one renderer —
`ModelIcon` for a model FAMILY (`models.icon`) and `ProviderLogo` for a
deployment's serving PROVIDER (rendered on every `ProviderBadge`). Marks
simple-icons drops for trademark reasons (openai, microsoft, amazon) plus
zai/GLM and fireworks are carried as local single-path glyphs on the same
monochrome contract, so every provider the catalog surfaces — OpenAI,
Anthropic, Gemini, Azure OpenAI, OpenRouter, Bedrock, Fireworks, Modal — paints
its real logo; the customer-run `local` lane, which has no brand, paints a
neutral Lucide server glyph. The remaining no-mark families (cohere, nous) and a
null icon fall back to a neutral letter tile. Never a second color, never
outside the catalog. The Lucide convention, used throughout
`apps/web/components/shell/`:

- **Sidebar and nav icons: `size={15}` `strokeWidth={1.8}`**, `aria-hidden`, and
  `shrink-0` when sitting next to a text label.
- Small inline affordances (chevrons, sign-out, inline actions) may drop to
  `size={12–13}`, keeping `strokeWidth` at ~1.8.
- Icons never carry meaning alone in expanded layouts — they accompany a label. The
  collapsed sidebar rail is the exception and compensates with the portal `Tooltip`.

## App shell

One sidebar (`apps/web/components/shell/AppSidebar.tsx`) serves every visitor.
Signed out it shows the same nav — Models, Logs, Insights, Docs, then Credits
and Settings — with a **Log in** button that opens the login modal in place
(never a `/signin` link). Signed in it adds the org switcher,
Overview, Admin (platform admins), the remaining credit balance shown inline on
the Credits nav tab (`SidebarCreditAmount`, polled from `/budget`), and the
account block. The signed-in footer cluster runs Access control / API Keys /
Credits / Settings. **Access control** (`/aliases`,
`app/(workspace)/aliases/page.tsx`; renamed from "Aliases" 2026-08-23) is the
one surface for who and what may call your models: the org's named model
aliases (`AliasesPanel` — create, repoint, roll back, retire) and the identity
tier (`components/identities/identities-access-panel.tsx` — identities, their
API keys, deny-by-default model grants, and monthly budgets at org / identity /
key / model scope). Every member reads the identity tier; org admins manage
everything. The old `/settings/identities` URL redirects there.
Nav entries never lock: pages are public, actions gate (see "Gating patterns"
below). Below 900px the rail reflows into a top bar with the same entries and
account/login at the right edge. The expand/collapse preference persists in a
cookie (`components/shell/sidebar-collapse.ts`) so the server paints the
remembered width on first paint.

## Chips

`Chip` (`apps/web/components/ui/Chip.tsx`) takes a `tone` from a fixed vocabulary.
The tone → color rules:

- **green** (`passed`, `accepted`, `completed`, `opened`, `no_changes_needed`) — a
  positive outcome,
- **red** (`failed`, `rejected`, `error`) — a failure,
- **amber** (`invalid`) — not a valid measurement,
- **blue** (`complete`) — finished, deliberately *not* green because completion is not
  an improvement signal,
- **gray with a subtle pulse** (`running`) — in flight,
- **light gray** (`queued`) and **muted gray** (`cancelled`) — inert states,
- **purple** (`future`, `backlog`) — speculative / not-yet-real items.

Product statuses never pick tones ad hoc: `apps/web/lib/format.ts` owns the
status-enum → tone mappings and label casing (e.g. `worldModelStatusTone`,
`buildJobStatusTone`). A new status enum gets a mapping function there, not an inline
tone choice at the call site.

## Shared primitives

Everything in `apps/web/components/ui/` is house style; reach for these before writing
new markup:

`Button` (variants: `default`, `primary`, `accent` — the page's one unmissable CTA,
`ghost`, `destructive`, `inverse`, `inverse-outline`; plus `buttonClassName()` for
link-as-button), `Card`, `Chip` + `SkeletonChip`, `ConfirmDialog` (danger/warning
confirmation), `DataTable` (the house dense table: column defs with cell renderers
and sort accessors, null values always sort last, optional row bands that sort
within their band — built for the models catalog, reusable by any row-level
surface), `DeleteResourceButton`, `Dropdown`, `EmptyState`, `ErrorTile`,
`LocalDateTime`, `Shimmer`, `SlidingTabs` (the house tab strip — the active ink pill
slides, never teleports), `Tooltip` (portal-based, anchors right of trigger; used by
the collapsed sidebar rail).

## Gating patterns: login modal and locked sections

Everything in the product renders signed-out; only *acting* is gated. These two
patterns are the only sanctioned ways to gate, and they ship with the app-shell
workstream. They are documented here first so every other workstream builds against
the same contract instead of inventing its own.

### The login modal and `useLoginModal()`

Auth happens in a modal, in place, wherever the user is. **Never navigate to `/signin`
from inside the app** (`/signin` remains only for invite links and direct hits).

Contract — a `useLoginModal()` hook provided app-wide by the shell:

```
const { open, requireAuth } = useLoginModal();
```

- `open()` — opens the login modal in place (OAuth + email/password).
- `requireAuth(fn)` — runs `fn` immediately if the user is signed in; otherwise opens
  the modal and runs `fn` after successful auth.

Wrap any gated action in `requireAuth`: playground send, credits top-up, key creation,
settings mutations, "use this model" actions. Navigation is never gated — pages are
public; actions gate. After a successful in-modal login the modal advances to a success
step (API key, brief confetti, "$20 in free credits", docs link); surfaces do not build
their own post-login flows.

The provider (`LoginModalProvider`) is mounted once, in the workspace group layout —
components under it just call the hook. Email/password logins resolve fully in-modal.
OAuth necessarily leaves the page: the modal sends the provider round-trip back to the
same page with a `?welcome=1` marker, which re-opens the modal on the success step and
is then stripped from the URL. Treat `welcome` as a reserved query param on every page;
`requireAuth` callbacks do not survive an OAuth reload (the surface re-renders
signed-in instead).

### Locked sections (signed-out settings-style content)

When a signed-out visitor reaches a surface whose *content* is account-scoped (a
settings section, a personal panel), the frame still renders — page, nav, headings —
and the content area renders the shared locked-state card (a `LockedSection` component
shipped by the app-shell workstream):

- a quiet `--surface` card on `--line` hairlines,
- one line saying what lives here (e.g. "API keys for calling the gateway"),
- one **Sign in** button wired to `useLoginModal().open`.

No account-scoped data fetches may fire signed-out. Do not hand-roll padlocks,
blurred previews, or redirect-to-signin flows; use the shared card so every locked
surface reads identically.
