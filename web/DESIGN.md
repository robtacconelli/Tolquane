# Tolquane Web: the design system

This is the contract the frontend is built against. It exists so the wave 2 agents (the
canvas, the code view, the run overlay, the AI panel, schedules and settings) produce
pieces that look like one product without coordinating on every detail.

Two rules govern everything below:

1. **Never hard-code a colour, a size or a radius.** Every value in a component comes
   from a token in `src/theme/tokens.css`. A component that needs a value the tokens do
   not have is a signal to add a token, not to write `#1f2937`.
2. **Dark is the default, light is not an afterthought.** Only colour tokens change
   between themes, so no component branches on the theme. If a piece looks wrong in
   light mode it is using a colour directly, or using a surface where it should use a
   border.

The accent is the teal the documentation site uses (`mkdocs.yml`, Material `teal`), so
the GUI and the docs read as one product.

## Tokens

All tokens are CSS custom properties on `:root`, prefixed `--tq-`. Theme-independent
tokens (type, spacing, radii, motion, layout, z-index) are defined once; colour tokens
are defined three times: once as the dark default, once under `:root[data-theme='dark']`
and once under `:root[data-theme='light']`.

### Colour, by role

| Group      | Tokens                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Surfaces   | `--tq-bg` (behind everything), `--tq-surface` (panels, sidebar, top bar), `--tq-surface-raised` (cards, popovers, modals), `--tq-surface-sunken` (inputs, canvas ground, console), `--tq-surface-hover`, `--tq-surface-active` |
| Borders    | `--tq-border-subtle` (structural seams), `--tq-border` (controls), `--tq-border-strong` (emphasis, ports)                                                                                                                      |
| Text       | `--tq-text`, `--tq-text-muted` (secondary), `--tq-text-subtle` (labels, placeholders, hints), `--tq-text-inverse`                                                                                                              |
| Accent     | `--tq-accent`, `--tq-accent-hover`, `--tq-accent-active`, `--tq-accent-soft` (tinted background), `--tq-accent-soft-hover`, `--tq-accent-contrast` (text on a filled accent), `--tq-accent-line` (accent-tinted border)        |
| Status     | `--tq-success`, `--tq-warning`, `--tq-danger`, `--tq-info`, each with a `-soft` background tint                                                                                                                                |
| Run states | `--tq-node-new`, `--tq-node-running`, `--tq-node-waiting`, `--tq-node-done`, `--tq-node-failed`, each with a `-soft` tint                                                                                                      |
| Depth      | `--tq-overlay` (modal scrim), `--tq-focus-ring`, `--tq-shadow-sm`, `--tq-shadow-md`, `--tq-shadow-lg`                                                                                                                          |
| Scrollbars | `--tq-scrollbar`, `--tq-scrollbar-hover`                                                                                                                                                                                       |

The five run states are the ones `Progress.nodes[*].state` reports (see
`docs/web-interfaces.md`, S2): `new`, `running`, `waiting`, `done`, `failed`. `running`
is the accent teal because a running flow is the app doing its job; `waiting` is amber
(a node blocked on input, output or a window is not an error, it is back pressure);
`failed` is the danger red. Use `<StatusDot state=… />` rather than painting them
yourself, so `running` gets its pulse and every dot gets the same halo.

The five are named once, in `components/nodeState.ts` (`NodeState`, `NODE_STATES`,
`NODE_STATE_LABEL`); import from there rather than writing the strings again. They are
the only palette for "how is it going", so the _run_ statuses of S3 — which are five
different words — are mapped onto them by `runStatusLook` in
`components/scheduleFormat.ts`: `deadlock` wears `failed`, `cancelled` wears `new`, and
a schedule that has never fired wears `new` too. A page showing a run's outcome calls
that rather than inventing a sixth colour, so the canvas, the runs list and the
schedules list agree at a glance. `--tq-success` and `--tq-danger` stay for _the app's_
own messages (a save worked, a delete is about to happen); a flow's state always uses
the `--tq-node-*` pair.

### Spacing

`--tq-space-0` … `--tq-space-12`: `0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96` px.
Padding inside a control uses 3-5; padding inside a panel uses 5-6; the gap between
panels on a page is 6; page padding is 8.

### Radii

`--tq-radius-xs` 3, `-sm` 5, `-md` 7, `-lg` 10, `-xl` 14, `-pill` 999. Controls are `md`,
panels and cards are `lg`, modals are `xl`, dots and chips are `pill`.

### Type

`--tq-font-ui` is a system stack, `--tq-font-mono` a system monospace stack. There are no
web fonts: the app has to work with no network at all.

Sizes: `--tq-text-xs` 11 (uppercase labels), `-sm` 12 (secondary text, table meta),
`-base` 13 (the body size of the UI), `-md` 14 (control labels, card titles, page
sub-heads), `-lg` 16, `-xl` 19 (page titles), `-2xl` 24.

Weights: `--tq-weight-regular` 400, `-medium` 500 (controls and nav), `-semibold` 600
(titles). Line heights: `--tq-leading-tight` 1.25 for headings, `-normal` 1.5 for UI,
`-relaxed` 1.65 for prose. `--tq-tracking-wide` is for the uppercase 11px section labels;
`--tq-tracking-tight` for headings 16px and up.

### Motion and layout

`--tq-duration-fast` 110ms for hover and colour, `-base` 180ms for panels and modals,
`-slow` 320ms; `--tq-ease` is the shared curve. Everything is disabled under
`prefers-reduced-motion` by `base.css`, so a component does not have to handle it.

`--tq-sidebar-width` 232, `--tq-sidebar-width-collapsed` 60, `--tq-topbar-height` 52,
`--tq-panel-width` 320 (the editor's property panel), `--tq-drawer-height` 208 (the
editor's bottom drawer), `--tq-content-max` 1080 (list and settings pages).

Z-index: `--tq-z-canvas` 0, `-sticky` 10, `-drawer` 20, `-overlay` 40, `-modal` 50,
`-toast` 60.

## Component conventions

- **CSS Modules only.** One `Thing.module.css` beside `Thing.tsx`. No utility framework,
  no CSS-in-JS, no UI kit. Class names are camelCase and describe the part, not the look
  (`.panelHeader`, not `.grayBar`).
- **Composition over props.** `Panel` + `PanelHeader` + children, not a `Panel` with
  fifteen props. Pass nodes (`actions`, `hint`) rather than adding booleans.
- **Every interactive element has hover, active, focus and disabled.** Focus is the one
  ring defined in `base.css` (`:focus-visible`, 2px `--tq-focus-ring`, 2px offset); do
  not write a component-specific focus style.
- **Heights are on a grid**: 24px (segmented control), 25px (`sm`), 30px (`md`, inputs),
  36px (`lg`). Icons are 14-15px inside `sm` controls, 16px normally, 17-18px in the top
  bar.
- **Icons** come from `components/Icon.tsx`: one stroked 24×24 set, `currentColor`,
  `stroke-width` 1.7, `aria-hidden`. Add to that file rather than inlining an SVG, and
  give the glyph the name of the thing rather than the shape. The set is small on
  purpose — an icon nobody can name is a label — and covers navigation (`flows`, `runs`,
  `schedules`, `settings`, `folder`), direction (`chevronLeft/Right/Up/Down`,
  `panelLeft/Right/Bottom`), actions (`plus`, `play`, `check`, `close`, `search`,
  `refresh`, `trash`, `pencil`, `command`), state (`alert`, `offline`, `clock`) and the
  editor's own (`code`, `canvas`, `map`, `sparkle`, `sun`, `moon`).
- **Illustrations** live in `components/Illustrations.tsx` and are inline SVG referring
  to theme tokens, so they follow the theme and cost no request.
- **Empty states are content, not apologies.** `EmptyState` takes art, a title, a
  sentence saying what will appear here and why, and the action that fills it. Never
  "no data".
- **Accessible names.** Icon-only buttons take `aria-label`; the sidebar keeps its text
  labels in the DOM when collapsed only through `title`, so it also carries `aria-label`
  where the text is hidden.
- **Numbers are tabular.** Anything that ticks (item counts, elapsed time, zoom level)
  uses `font-variant-numeric: tabular-nums`.
- **Key hints come from `src/platform.ts`** (`MOD_KEY`, `MOD_KEY_K`): `⌘` on Apple,
  `Ctrl` everywhere else. Never write `⌘` into a component; most people run this on
  Linux next to a terminal.

## The block card

`components/BlockCard.tsx` is the card the canvas draws for every block; the block kinds
live beside it in `components/blockKinds.tsx`. Wave 2's `@xyflow/react` node types render
this component so the palette, the canvas and any preview agree.

```
 ┌────────────────────────────────────┐
 │▌ ┌────┐  Title                 ● ──┤──▶  status dot (run state), right edge
─┼──│icon│  subtitle                  │
 │  └────┘                            │
 └────────────────────────────────────┘
  ▲                                  ▲
  kind stripe                        output port
```

- **Size**: 208px wide, `--tq-space-4`/`--tq-space-5` padding, `--tq-radius-lg`,
  `--tq-surface-raised` on a 1px `--tq-border`, `--tq-shadow-sm`.
- **Kind stripe**: a 2px rounded bar down the left edge in the kind's accent. Structural
  blocks (`farm`, `comb`, `feedback`, `all2all`) take `--tq-accent`; `source` takes the
  done green, `sink` the danger red, `node` and `raw` stay neutral. A canvas of plain
  stages is therefore calm, and the structure stands out.
- **Icon**: a 28px `--tq-radius-md` tile on `--tq-accent-soft`, holding the kind's 17px
  glyph in the stripe colour.
- **Title**: the node's name, `--tq-text-md` semibold, one line, ellipsised.
- **Subtitle**: what it is in Tolquane terms — `tq.farm · 8 workers`, `tq.node`,
  `ordered · capacity 64`. `--tq-text-sm`, `--tq-text-subtle`, one line, ellipsised.
- **Status dot**: top-right, only while a run is attached; `running` pulses. Off the
  canvas (in a palette or a picker) there is no dot.
- **Ports**: 9px circles centred on the left and right edges, `--tq-surface` filled with
  a 2px `--tq-border-strong` ring, overhanging the card by 5px so an edge meets the
  circle's centre. `hasInput`/`hasOutput` turn them off for a source's left and a sink's
  right.
- **Selected**: `--tq-accent` border plus a 3px `--tq-accent-soft` ring and
  `--tq-shadow-md`. **Ghost** (drag preview, drop target): dashed `--tq-border-strong`,
  a translucent surface (not a faded card: the title has to stay readable over the
  canvas grid in both themes), no shadow.
- **Containers** (a farm holding its worker, feedback holding its inner block) are not a
  variant of this card: draw a panel with the same border, radius and stripe, a header
  row shaped like the card's own header, and the child cards inside it with
  `--tq-space-5` padding.
- **Run overlay** (F4) tints the card by state: keep the border, add
  `box-shadow: 0 0 0 3px var(--tq-node-<state>-soft)` and set the status dot. Do not
  change the card's background: the text has to stay readable in both themes.

### The sizes the canvas lays out with

Every number the editor measures and places with is a constant in
`src/editor/geometry.ts`, so the layout, the drop targets and the mini-map cannot drift
apart. `measure` says how big a sub-tree is and `buildGraph` puts it somewhere; both
walk the tree the same way, from these:

| Constant                     | px       | What it is                                                     |
| ---------------------------- | -------- | -------------------------------------------------------------- |
| `CARD_W` / `CARD_H`          | 208 / 64 | The block card above, with a title and a one-line subtitle     |
| `COMB_H`                     | 92       | A comb: one card showing the two nodes it fuses                |
| `END_W` / `END_H`            | 124 / 48 | A farm's emitter and collector, the small end cards inside     |
| `GAP_X`                      | 56       | Between top-level stages, where an edge has room to be seen    |
| `GAP_IN`                     | 28       | Inside a container, where the eye knows what belongs together  |
| `GAP_Y`                      | 20       | Between stacked cards (a heterogeneous farm, an all-to-all)    |
| `GROUP_HEADER` / `GROUP_PAD` | 42 / 16  | A container's header row, then the padding around its children |
| `LOOP_SPACE`                 | 44       | Room under a feedback loop for the edge that goes back         |
| `MAX_REPS`                   | 3        | Worker cards an all-to-all draws per side before "and N more"  |

A new container kind adds its constants there and nowhere else. Nothing on the canvas
hard-codes a pixel, for the same reason nothing hard-codes a colour.

## Forms

`src/components/form/` is the blessed set of primitives, and a screen that needs an
input reaches for these before writing its own. They are deliberately thin — they
compose, they do not configure.

- **`Field`** is the wrapper every control goes in: a label row (with an optional
  `aside` for a badge or a small inline action), the control, and one line underneath
  that is _either_ the hint _or_ the error, never both, so a field never changes height
  when it goes wrong. Pass `htmlFor` and give the control the same `id`.
- **`TextInput`** (`mono` for paths, cron and code; `invalid` for the error state, which
  also sets `aria-invalid`) and **`NumberInput`**, which is a text input by design: the
  spinner buttons are noise and the rules are ours anyway.
- **`Select`** is a native `<select>` in our own frame with a drawn caret, so the
  keyboard and the platform's own list behaviour are free.
- **`Toggle`** is a `role="switch"` button with no text of its own; `label` is its
  accessible name and its tooltip. Use it for something that takes effect at once (a
  schedule being enabled). For a choice that is saved with the rest of a form, use
  **`CheckLine`**, a checkbox with its label on one line.
- **`Badge`** carries the five tones (`neutral`, `accent`, `success`, `warning`,
  `danger`) for a word beside a title. A run's state is not one of these: that is
  `StatusDot` and the `--tq-node-*` colours.
- **`Dialog`** is the modal shape the command palette established — scrim, raised panel,
  header, scrolling body, footer of actions. Escape and the scrim close it, Tab stays
  inside it, and the control marked `data-autofocus` takes the focus. `width` defaults
  to 640. **`ConfirmDialog`** (440 wide, a `danger` button, a `busy` state) is the one
  question worth a modal: something is about to be destroyed. Do not build a second
  confirmation shape.

A form's own layout (two columns, a row of actions) belongs to the page; the controls
belong here. If a screen needs a control this file does not have, add it here rather
than beside the screen.

## The app shell

- **Sidebar** (`--tq-sidebar-width`): the wordmark in a band the height of the top bar,
  a `Workspace` section label, the four nav items, and a footer with the server status
  dot and the collapse button. Active nav item: `--tq-accent-soft` pill,
  `--tq-accent` text. Collapsed, everything centres and the labels go, and the shell's
  grid column animates.
- **Top bar** (`--tq-topbar-height`): breadcrumbs ending in an `<h1>`, then the omnibox
  (a button, never an input) and the theme toggle.
- **Offline banner**: a slim `--tq-warning-soft` strip under the top bar with
  `role="status"`. It is deliberately quiet — the server not being up is a normal state,
  not an error — and it only appears after a poll has actually failed.
- **Command palette**: `Cmd/Ctrl+K`, a 560px `--tq-radius-xl` modal at 12vh, a search
  row, grouped rows with icons and right-aligned hints, and a footer of key hints.
  Wave 2 fills in the behaviour; the frame and the row shape are fixed here.
- **Editor page** is the only full-bleed page: a toolbar across the top, the canvas at
  the left, the property panel down the right (full height, `--tq-panel-width`), and the
  drawer under the canvas (`--tq-drawer-height`). List and settings pages are centred at
  `--tq-content-max` with `--tq-space-8` padding.

## Adding a page

```tsx
<Page>
  <PageHeader title="…" description="…" actions={<Button variant="primary">…</Button>} />
  <Panel>
    <PanelHeader title="…" hint="…" actions={…} />
    <ListColumns columns={[…]} template="minmax(0, 2fr) 110px …" />
    {rows.length ? rows.map(…) : <EmptyState art={…} title="…" body="…" actions={…} />}
  </Panel>
</Page>
```

The column header stays when the list is empty: it tells the reader what will be here.

## The state store

`src/store/ui.ts` is a single Zustand store for what the _shell_ remembers, nothing else:

```ts
{
  (themeMode,
    theme,
    sidebarCollapsed,
    paletteOpen,
    setThemeMode,
    toggleTheme,
    syncSystemTheme,
    setSidebarCollapsed,
    toggleSidebar,
    setPaletteOpen);
}
```

`themeMode` is the choice (`system | light | dark`, in `localStorage` under
`tolquane.theme`); `theme` is that choice resolved, and the only thing components read.
Every `localStorage` access is wrapped, because a private window throws.

Wave 2 areas own their own stores next to their code -- `store/flow.ts` for the open flow
and its undo stack, `store/run.ts` for the live run -- rather than growing this one. Two
rules keep them composable: select narrowly (`useUiStore((s) => s.theme)`, never the
whole store), and keep server data out of the store; it belongs to the component or hook
that fetched it, and the shell already shares the health poll through
`useAppShell().server`.

## The API client

`src/api/client.ts` is the transport, and it is hand-written on purpose: `request()`,
the `api.get/post/put/delete` shorthands, `ApiError` (`status`, `code`, `detail`, `url`,
`isOffline`) and the abort/timeout handling. Errors are normalised there, so nothing
else in the app touches `fetch` or has to know the server's error envelope.

The _typed route surface_ is generated. The server's OpenAPI document is the contract:

```
tolquane web --openapi > web/openapi.json    # from the repository root
npm run api:types                            # regenerates src/api/schema.d.ts
```

`openapi.json` and `schema.d.ts` are both checked in, because the frontend build has no
Python in it. Two tests keep them honest: `tests/web/test_openapi.py` fails when the
document no longer matches the live app, and `src/api/schema.test.ts` fails when the
types no longer match the document. Both say those two commands.

The rules that follow from it:

- **Every call lives in `src/api/`**, never in a component or a store. A component that
  wants data calls a wrapper.
- **A wrapper is one line over `request()`**: `export const getFlow = (path: string) =>
api.get<FlowDetail>(at(path));`. Names and behaviour are ours and stable; only the
  types underneath them change when the server does.
- **No server shape is written by hand.** `client.ts` exports `Schemas`
  (`components['schemas']` of the generated file) and every other file in `src/api/`
  takes its request and response types from it. Two helpers make the generated types
  read the way the wire actually behaves: `Complete<T>` for a response (FastAPI
  serialises every field of a response model, defaults included, so a field the schema
  marks optional is still always there) and `Optional<T, K>` for a request body (the
  fields the server fills in for itself may be left out).
- **What the UI adds is written down, and only that.** Three kinds of thing:
  a `str` the server will only ever answer with one of a few words (`Runtime`,
  `RunStatus`/`RunPhase`, `AiProvider`), given its union; a `dict` FastAPI passes
  through untyped, given its real S1 type (`FlowModel`, `GraphView`, `Layout`,
  `CodeOnly`, the run report, `last_run`); and the things that never cross HTTP at all —
  the run events of S2, which arrive on a WebSocket, and the AI chat's server-sent
  events. Everything else is a re-export of the generated type.
- **Where the UI and the schema disagree, the schema wins.** A narrowing is fine, a
  contradiction is a bug in one of them.
