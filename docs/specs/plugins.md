# Plugins (Load Order) — Surface Specification

**Status: Specced — ready to build.** This spec supersedes the earlier skeleton; its shape was
confirmed in a `/grill-with-docs` session (2026-07-10). Tracked as issue
[#7](https://github.com/WhiskyTangoFawks/ModBench/issues/7) (Modbench-9).

Mod Management context — operates on physical plugin files (`.esm`/`.esp`/`.esl`) and
`plugins.txt`; never on records or FormKeys. Distinct from the Editing-context Plugins tree
([medit-plugins-tree.md](medit-plugins-tree.md)), which lists plugins as the entry point into per-record browsing and
requires a spawned backend — this surface manages **Plugin load order**, not record content,
and works without the editing backend running.

**Vocabulary note:** "load order" is ambiguous across Modbench's two contexts and this spec
uses the disambiguated terms throughout — see [CONTEXT-MAP.md](../../CONTEXT-MAP.md) and each
context's `CONTEXT.md`:

- **Mod load order** — `modlist.txt` order (the **Modlist**, owned by the Mods tree); later
  position wins **file** conflicts.
- **Plugin load order** — `plugins.txt` order (owned by this surface); later position wins
  **record-override** conflicts (an Editing-context concern this surface's artifact feeds).

## Purpose

Reconstruct MO2's Plugins tab: view and manage `plugins.txt` — the Plugin load order — as a
first-class, always-available part of the Loadout workflow: enable/disable, drag-and-drop
reorder, and missing-master detection. (Dependency-aware auto-sort, originally sketched for
this surface, is **deferred indefinitely** — see Out of Scope.)

## Placement ([ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md))

A sidebar `TreeView`, stacked below the Mods tree in the `modbench` view container, visible
(`when: modbench.viewMode == 'loadout'`) alongside it — not a switchable tab, not folded into
the mEdit Plugins tree. Reuses the `TreeDragAndDropController` pattern already built for the
Mods tree ([mods.md](mods.md) §UI — Mods tree) for reorder.

**Naming:** displays as **"Plugins"** in the UI — the same label as the Editing-context tree
(`medit-plugins-tree.md`). The two are visible in mutually exclusive `viewMode`s, so this costs nothing
at the UI layer (confirmed: VS Code's auto-generated "Focus on {view} View" palette entry is
gated by the view's own `when` clause). At the code/spec level the two stay fully distinct:
this view is `modbench.pluginListTree`, owned by `modmanager/`, with its own contextValues,
separate from `medit/`'s `modbench.pluginTree`.

Freely relocatable by the user (e.g. to the auxiliary bar, to reconstruct MO2's literal
side-by-side layout) via VS Code's native "Move View" — but never defaults there, per
ADR-0027's auxiliary-bar convention.

## Problem Statement

Modbench already reads and writes `plugins.txt` internally — `explicitSession.ts` derives the
Editing session's Plugin load order from it — but nothing lets a user *see or manage* it. A
plugin whose master loads after it will CTD the game with no warning in Modbench; today the
only way to inspect or fix `plugins.txt` is MO2's own Plugins tab or a hand edit.

## Solution

A **Plugin List** sidebar tree — one row per `plugins.txt` line, in Plugin load order — with a
checkbox (enable/disable), drag-and-drop reorder (single- or multi-row), an order-aware
missing-master badge, a Filter box, and a Reveal-in-Explorer row action. It mirrors MO2's
Plugins tab closely enough to alternate between the two on the same instance.

## User Stories

1. As a user, I want a Plugins list showing every entry in `plugins.txt`, in Plugin load
   order, so that I can see what the game will actually load and in what sequence.
2. As a user, I want each plugin shown as a single row, so that the list maps one-to-one to
   `plugins.txt`'s lines — no separate row for a same-named plugin another mod also ships;
   `plugins.txt` itself only ever has one line per plugin name, so there's nothing to dedupe.
3. As a user, I want vanilla, DLC, and Creation Club plugins listed alongside mod-provided
   ones, so that I see the whole Plugin load order the game will actually load, not just the
   subset that came from an installed mod.
4. As a user, I want a checkbox on each row that enables/disables the plugin, writing
   `plugins.txt` immediately, so that toggling a plugin works the same way every other
   mutation in this bounded context does — no separate save step.
5. As a user, I want to be able to toggle a vanilla/DLC/CC plugin's checkbox the same as any
   other row, so that Modbench doesn't invent a restriction MO2 itself doesn't have.
6. As a user, I want a missing-master badge on a plugin whose master isn't loaded *before* it
   — whether the master is absent entirely or just sequenced too late — so that I catch the
   actual CTD-causing condition, not just "is the master present somewhere."
7. As a user, I want that badge's message to make clear it's checking order, not just
   presence, so that I understand why it can disagree with the Mods tree's own (presence-only,
   mod-granularity) missing-master badge on the same plugin.
8. As a user, I want to drag a plugin to a new position and have `plugins.txt` reordered
   immediately, so that fixing a load-order problem is a direct manipulation, not a form.
9. As a user, I want to ctrl/shift-click to select multiple plugins and drag them together as
   a block, so that reordering a cluster of related plugins doesn't take one drag per plugin.
10. As a user, I want a Filter box that narrows the list to plugins whose filename matches
    what I type, so that I can find one without scrolling a 100+-entry load order.
11. As a user, I want a Refresh button, so that I can force a re-read of `plugins.txt` if the
    list ever looks stale (e.g. after an external MO2 edit).
12. As a user, I want to right-click a plugin and Reveal it in my OS file manager, so that I
    can go inspect the actual file behind a badge without hunting for it myself.
13. As a user, I want this list visible any time I'm in Loadout mode, with no separate
    open/launch step, so that it behaves like the Mods tree it's stacked with, not like the
    occasional-use Downloads tab.
14. As a user, I want a clear error state if `plugins.txt` can't be read, so that a corrupt or
    missing file doesn't just silently show an empty list.

## Implementation Decisions

### Scope

- This spec covers the **Plugin List surface only**: the sidebar tree, checkbox, drag reorder,
  the order-aware missing-master badge, the Filter box, Refresh, and the Reveal-in-Explorer
  row action.
- **Auto-sort** (dependency-aware topological sort, LOOT parity) is **out of scope, deferred
  indefinitely** — a possible future initiative of its own, not scheduled. See Out of Scope.
- **Cross-highlight with the Mods tree** (selecting a plugin highlights its providing mod(s)
  and vice versa, MO2 parity) is **deferred** to
  [#62](https://github.com/WhiskyTangoFawks/ModBench/issues/62) — blocked by a real VS Code
  API limitation, not a priority call. See Out of Scope.
- **No "Mod" column.** Which mod provides a plugin is surfaced only via the (deferred)
  cross-highlight, matching MO2's own implicit-link design — see #62.
- **No "Open in mEdit"** jump from a plugin row into the Editing per-record tree in v1.

### Row model

- **One row per non-comment, non-blank `plugins.txt` line**, in file order — top of the list
  loads first, bottom loads last and wins record-level overrides (same last-wins polarity as
  the Mods tree's `modlist.txt`, just a physically different file and a different conflict
  axis — see the Vocabulary note above).
- No dedup step at render time: the row set **is** `plugins.txt`'s line set. Winner resolution
  between same-named plugins from different mods is a Mod-Management concern the Plugin List
  doesn't compute or care about — it only manages the sequence of names.
- Checkbox reflects the line's `*` prefix (MO2's own enabled marker).
- No lock/immutable icon on vanilla/DLC/CC rows (unlike the Editing tree's immutable-plugin
  lock, `medit-plugins-tree.md`) — that icon means "read-only," and these rows are deliberately
  toggleable, so borrowing that icon would misrepresent them.

### Missing-master badge (order-aware)

Stronger than the Mods tree's badge, and deliberately so — this view has the one thing the
Mods tree structurally lacks: an actual plugin sequence to check order against.

- For each plugin, read its declared masters via the existing `readMasters()`
  (`masterReader.ts`, TES4 header read — already used by `statusChecker.ts`).
- Flag the plugin if any declared master is **absent from `plugins.txt` entirely**, or
  **present but positioned after this plugin's own line** — both are real CTD conditions; the
  Mods tree's badge (presence-only, mod-granularity, no order dimension) only catches the
  first.
- Badge/tooltip text names the condition explicitly (e.g. "Master `{name}` is not loaded
  before this plugin") so it reads distinctly from the Mods tree's "Missing master: {names}" —
  the two can legitimately disagree on the same plugin, and the wording should make it obvious
  why rather than looking like a bug. No ADR needed for this divergence — the modding-literate
  audience understands presence-vs-order implicitly once the badge text says so.
- Vanilla masters are ordinary rows in this list (per Row model above), so an order check
  against them works the same as for any mod-provided master — no special-casing needed.

### Selection & drag

- `canSelectMany: true`.
- Drag-and-drop reorders the current selection (single or multi, contiguous or not) as a
  block, moving all selected rows to the drop index while preserving their relative order —
  same `TreeDragAndDropController` mechanics already built for the Mods tree's separator-block
  drag, applied to an arbitrary row selection instead of a separator's contiguous children.
- Writes `plugins.txt` immediately on drop — no save/discard step, matching every other
  mutation in this bounded context.

### Toolbar / title bar

- **Refresh** — forces a re-read of `plugins.txt` (safety valve). No live file-watcher: no
  file-watcher exists anywhere in `modmanager/` today, not even for the Mods tree's own
  `modlist.txt` (equally exposed to external MO2 edits) — this view matches that existing
  precedent rather than introducing live-watch (which Downloads chose for a different reason:
  files arriving from an external download client, not a hand-edited config file).
- **Filter** — magnifier icon opens a transient `InputBox` (same widget/pattern as the Mods
  tree's filter, `vscode.window.createInputBox()`), live-narrowing rows by case-insensitive
  substring match against plugin filename. Dismissing the box (`onDidHide`) restores the full
  list. This same pattern now spans every Modbench list surface: Mods tree (existing),
  Downloads ([#61](https://github.com/WhiskyTangoFawks/ModBench/issues/61), retrofit), the
  Editing Plugins tree (`medit-plugins-tree.md`, new), and here.

### Row context menu

- **Reveal in Explorer** — resolves the plugin name to its physical path (same winner
  resolution `explicitSession.ts` already performs via `FileConflictIndex`, falling back to
  the game's `Data/` folder for an unmanaged vanilla/DLC/CC plugin) and reveals it in the OS
  file manager. Same primitive as the Mods tree's existing "Open in Explorer"
  (`revealFileInOS`). No other row actions in v1.

### Write mechanism

- A new pure `pluginsText.ts`, templated directly on `modlistText.ts`'s byte-faithful
  splice-transform pattern: parse `plugins.txt` into an ordered model view, mutate via surgical
  splice (`lineRanges`, `mo2/lineScan.ts`) — never model→re-serialization — so comments, blank
  lines, and CRLF/BOM survive untouched. `plugins.txt`'s format is simpler than `modlist.txt`'s
  (no separator concept), so this is templating an established pattern, not new design.
- `IModlistSource` gains the write-side counterparts to its existing read-only
  `readPluginOrder()`/`readEnabledPlugins()`: toggle a line's `*` prefix, and reorder lines —
  mirroring the shape of the existing `modlist.txt` mutators (`moveModToSeparator`,
  `reorderSeparatorBlock`).

### Entry point

- No open/launch command. The tree is simply present whenever `modbench.viewMode == 'loadout'`
  — identical in spirit to the Mods tree itself, unlike Downloads' editor-tab-on-demand model.

### Empty / error states

- **Read failure** (missing/corrupt `plugins.txt`) — a single error tree node, per the existing
  `modmanager/CLAUDE.md` convention ("show an error tree node instead of an empty list when a
  fetch/read fails"), warning surfaced via the injected reporter per
  [ADR-0026](../adr/0026-error-surfacing-policy.md).
- **Empty `plugins.txt`** (no lines) — realistically near-unreachable (vanilla masters always
  populate it) but handled for completeness: a single informational node, "No plugins," mirroring
  the Pending Changes tree's empty state (`medit-pending-changes-tree.md`).

### Architecture / seams

- **Primary seam**: `pluginsText.ts` (parse + mutate), pure, Vitest-tested, no `vscode` import —
  same seam class as `modlistText.ts`/`metaIni.ts`/`downloads.ts`.
- **Missing-master order-check**: a pure function taking (a plugin's declared masters via
  `readMasters()`, the ordered plugin-name list, that plugin's own index) → a verdict. Lives
  alongside or extends `statusChecker.ts`; exact module boundary is an implementation call, not
  a spec decision.
- **Thin VS Code adapter**: a new `PluginListProvider` (`TreeDataProvider`), a
  `TreeDragAndDropController` reusing the Mods tree's established controller shape, the
  Filter `InputBox` reusing the Mods tree's exact pattern, and Reveal-in-Explorer reusing the
  same `revealFileInOS` call the Mods tree's "Open in Explorer" already makes. None of this
  layer holds logic beyond wiring.

## Testing Decisions

- **Good tests assert external behavior, not implementation details** — same standard as every
  other surface spec in this directory: given `plugins.txt` text + a mutation, assert the
  resulting text; given a plugin's masters + the ordered plugin list, assert the verdict.
- **Primary unit seam — `pluginsText.ts`** (Vitest, `npm run test:unit`, no backend):
  - parse: line → row mapping, comments/blanks ignored but preserved on write.
  - toggle: `*` prefix set/cleared, byte-faithful (CRLF/BOM/comments untouched).
  - reorder: single-row and multi-row (contiguous and non-contiguous selection) moves,
    byte-faithful.
- **Missing-master order-check unit tests**: master present-and-before → ok; master
  present-but-after → flagged; master absent → flagged; vanilla master present-and-before → ok
  (no special-casing needed, per Row model).
- **Prior art**: `modlistText.test.ts`, `metaIni.test.ts`, `statusChecker.test.ts` — same
  fixture-in/value-out style; instance fixtures live under
  `modbench/src/modmanager/test/fixtures/`.
- **Reused integration seam** (`npm run test:integration`, real VS Code process): tree renders
  from `plugins.txt`; checkbox toggle round-trips; drag-reorder round-trips; Filter narrows and
  restores; Reveal in Explorer dispatches; read failure renders the error tree node. Add new
  command id(s) to `EXPECTED_COMMANDS` (`modbench/CLAUDE.md`).

## Out of Scope

- **Auto-sort** (dependency-aware topological sort, LOOT parity) — deferred indefinitely; not
  scheduled, may become its own future initiative.
- **Cross-highlight with the Mods tree** on selection (MO2 parity) — deferred, tracked as
  [#62](https://github.com/WhiskyTangoFawks/ModBench/issues/62). Blocked by a confirmed VS Code
  API limitation (no programmatic multi-item selection, `FileDecoration` can't paint a full row
  background) rather than a priority call; #62 records the provisional approach
  (`FileDecorationProvider` color/badge tint) for whenever it's picked up.
- **A "Mod" column** or any textual plugin→mod ownership display — deliberately dropped in
  favor of the (deferred) cross-highlight, matching MO2's implicit-link design rather than
  inventing a text column MO2 itself doesn't have.
- **"Open in mEdit"** — jumping from a plugin row into the Editing per-record tree is not
  built; would need to resolve cross-context session-spawn semantics first (Editing requires a
  spawned backend; this view deliberately doesn't).
- **Guard-railing vanilla/DLC/CC masters** against being disabled — deliberately not added;
  MO2 doesn't guard-rail it either, and the order-aware missing-master badge catches the
  fallout if it happens.

## Further Notes

- **Glossary updated this session** — `CONTEXT.md` (Editing) and
  [modmanager `CONTEXT.md`](../../modbench/src/modmanager/CONTEXT.md) now distinguish **Plugin
  load order** (this surface's subject, `plugins.txt`, record-level) from **Mod load order**
  (the Modlist, `modlist.txt`, file-level) — previously conflated under one ambiguous "load
  order" term. [CONTEXT-MAP.md](../../CONTEXT-MAP.md)'s Mod-Management→Editing relationship
  description was corrected to match: the Editing session's plugin *order* comes from Plugin
  load order, not Modlist order (Modlist only resolves each plugin *name* to its winning
  physical file).
- **Filter box is now a declared cross-surface convention**, not a per-surface bespoke choice:
  Mods tree (existing), Downloads (retrofit, #61), Editing Plugins tree (`medit-plugins-tree.md`, new),
  and this surface.
- **Deferred follow-up**: [#62](https://github.com/WhiskyTangoFawks/ModBench/issues/62)
  (cross-tree highlight).
