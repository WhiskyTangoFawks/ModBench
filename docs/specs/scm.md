# Aggregate SCM provider — Surface Specification

> **Retiring — superseded by [ADR-0041](../adr/0041-manual-git-tracking-compile-from-text.md)
> (2026-08-19).** This surface is deleted in the milestone-5 rebuild with no fallback
> shim: tracked mods become real in-folder git repos displayed by VS Code's own git
> extension (`vscode.git` `openRepository`, one native SCM group per tracked mod). This
> spec describes shipped behavior only until the demolition slice lands; fold-on-ship
> replaces it with the Track/Compile surface spec.

**Status: Implemented (stage 1 of 3, ADR-0040).** [ADR-0040](../adr/0040-git-native-pending-changes.md)
(git-native pending changes) and [ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md)
(native-surface precedent).

Editing context — operates on **records**, **FormKeys**, and **plugins**; the Mod-Management
vocabulary ("mod", "loadout", "deploy") belongs to the sibling surfaces, not here
([CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary: [CONTEXT.md](../../CONTEXT.md)).

One of the mEdit view's surfaces — see [medit.md](medit.md) for the shared session lifecycle,
vocabulary, and architecture seams — but rendered on VS Code's native **Source Control** panel
rather than inside the `modbench` activity-bar container, since that is the platform's own home
for this exact interaction (ADR-0027).

**Pending-change UX follows git/VS Code native idioms, not xEdit** — xEdit has no pending-change
model, so it is not the reference here (root `CLAUDE.md`, ADR-0034 exception). The reference is
this surface's own vocabulary — working tree, commit, diff — and the [Pending Changes
tree](medit-pending-changes-tree.md), which this surface is intended to eventually supersede
(stage 3; not yet — see Further Notes).

## Problem Statement

Stage 1 of the git-native pending-changes migration ([ADR-0040](../adr/0040-git-native-pending-changes.md))
gives every tracked record a hidden per-origin git repository: staging a field edit writes it as
uncommitted working-tree text, vendored copy-on-write on first touch. That state existed nowhere
on the wire or in the UI until this surface — a user had staged, git-backed changes with no way to
see them as *changes*, and no way to review what actually differs from the last-known-good text
short of reading YAML files by hand.

## Solution

A single Modbench source-control provider on the native Source Control panel, backed by
`GET /ledger/status` — a read of real git repository state across every tracked plugin in the
current session, not a re-derivation of it. One working-tree resource group holds one resource per
changed record, spanning plugins and origins. Clicking a resource opens a text diff of that
record's committed (`HEAD`) text against its current working-tree text.

## User Stories

1. As a user, I want every record I've staged an edit against to show up as one changed row on the
   Source Control panel, however many different plugins those edits touch, so that "what have I
   actually changed" is one place to look regardless of where the edits landed.
2. As a user, I want each changed row to say what kind of change it is, so that I don't have to
   open a diff just to tell a modification apart from anything else.
3. As a user, I want to click a changed row and see exactly what differs — the record's last
   committed text against its current text — so that I can review an edit the same way I'd review
   any other git change, without leaving VS Code.
4. As a user, I want the panel to catch up on its own once I stage, save, or revert an edit, so
   that it never shows me a world that no longer exists.

## Implementation Decisions

- **One aggregate provider, not one per plugin** — `vscode.scm.createSourceControl('modbench.ledger',
  'Modbench')`, a single instance for the whole session. ADR-0040 and #366 rejected a
  provider-per-plugin design: the per-provider header row VS Code renders for each `SourceControl`
  instance does not scale to a loadout of dozens or hundreds of plugins.
- **One resource group**: `workingTree` / **"Changes"** — the same id/label VS Code's own SCM
  provider guide uses for this exact concept, copied rather than reinvented (native-first). Hidden
  when empty.
- **A resource's identity is a record**, not a plugin or a field: `{plugin, origin, recordType,
  formKey}`, one entry per record with working-tree dirt. A record touched through more than one
  target plugin (an override edited via a patch) appears once per (plugin, record) pair it was
  actually staged against, matching the ledger's own per-`(pluginFileName, recordType, formKey)`
  path identity.
- **Backend contract**: `GET /ledger/status` (`LedgerEndpoints`, `LedgerStatusQuery`) reads git
  status scoped to `*.ledger/*` under every origin folder the current session's load-order plugins
  resolve to — never the whole origin folder unscoped, which would report the plugin binary and
  its own `.bak` backups as spurious changes (nothing in `LedgerRepository.EnsureRepo` writes a
  `.gitignore`). Answers `200` with an empty list when no session is loaded — a true and complete
  answer ("no session, therefore no tracked changes"), not an error; see `/session/status` for the
  same read-projection convention. Each entry carries the record's committed (`HEAD`) text inline,
  since the alternative (a second endpoint, fetched per click) buys nothing yet: today's records
  are one small YAML file each, and nothing else consumes ledger state to justify the extra route.
  This does mean the response payload scales with the number of changed records — acceptable at
  today's realistic staged-edit counts, worth revisiting if a very large change set ever makes it
  the wrong tradeoff. Status reads use `git status --porcelain -z`, not plain `--porcelain` — `-z`
  disables git's default path-quoting, which otherwise C-quotes and octal-escapes any non-ASCII
  byte (routine in this modding scene: accented, Cyrillic, CJK plugin names) and would silently
  drop the record from the panel. A single origin folder's git read failing (a corrupt gitdir, a
  filesystem fault) is isolated to that origin — logged and omitted, every other origin's entries
  still returned — so one broken repo never blanks the panel for plugins it doesn't touch.
- **Ledger-tree lifetime follows its plugin's** (#392): session load reconciles each origin
  folder's ledger trees against the plugins actually present. A tree orphaned by a plugin
  removed outside Modbench is committed-removed (history stays reachable in the repo); a
  rename carries the tree — with history surviving under `git log --follow` — only when
  exactly one present, untracked plugin's indexed records satisfy every FormKey the orphan
  tracks (authored FormKeys remapped to the candidate's name). Anything ambiguous degrades
  to removal, never a guessed rename. Reconciliation is best-effort per origin (a git
  failure logs and skips, never blocks load) and commits nothing on a clean load. This is
  what keeps #374's precise sibling-match deploy exclusion sufficient: an orphan never
  survives to the next deploy, so the exclusion rule never needed loosening. `SourceControlResourceState` has no label
  field — VS Code derives what a row shows from its `resourceUri` alone: the file's basename as
  the row text, its containing folder as native dimmed context. A resource's `resourceUri` is the
  record's real ledger file (`<plugin>.ledger/<recordType>/<originModKey>/<hex6>.yaml`), so the row
  reads as that file's own name (e.g. `000800.yaml`) with its path as context — never a constructed
  `{recordType} {formKey}` string. That string exists only as the diff tab's title (see below). The
  ledger path itself is not reshaped to force a friendlier basename, and no separate label
  mechanism is invented to fight this — the path is committed history #370/#371 depend on, and
  bending the native surface to fit a wish is exactly what the native-first invariant forbids. If
  `000800.yaml` proves hard to scan once it's actually in front of users, that is a real,
  observation-backed follow-up, not a guess made here.
- **Full identity lives in the tooltip.** `SourceControlResourceDecorations.tooltip` genuinely
  supports it, so each resource's tooltip carries record type, FormKey, plugin, and change kind
  together (`{recordType} {formKey} · {plugin} ({kind})`) — the identity the row itself can't show.
  EditorID is not resolved into this string; a FormKey is always unambiguous, and resolving a
  friendlier form would pull a record-index query into a surface whose whole job, this stage, is
  reading real repo state. Deferred deliberately, not an oversight.
- **Change-kind decoration**: the same tooltip string above names the kind (`Modified`, `Added`,
  `Deleted`, `Renamed`, or `Unknown`), and a `FileDecorationProvider` (same pattern as
  `PendingChangeDecorationProvider`, #331) badges the matching row with git's own single-letter
  vocabulary (`M`/`A`/`D`/`R`/`U`) plus its own, kind-only tooltip. `Modified` is the only kind
  today's write paths can actually produce — `RecordVendor` always commits a record's pristine
  baseline before any dirt is ever written, so a tracked record is never "added" or "deleted" from
  the ledger's own perspective — but the kind is read honestly off git's real porcelain status code
  rather than hardcoded, so a future write path (or an external edit to ledger text) reports as
  what it is.
- **The diff is raw text, committed vs. dirty** — `vscode.diff(committedUri, dirtyUri, title)`, VS
  Code's own two-URI diff-editor command, the same one every SCM extension (including git's own)
  drives this interaction through. The dirty side is the real working-tree file on disk
  (`vscode.Uri.file`, no further backend round trip — `RecordVendor` already wrote it there); the
  committed side is served from a `modbench-ledger-committed:` scheme by a
  `TextDocumentContentProvider` (the same class), backed by the committed text `GET /ledger/status`
  already returned — never a second fetch. **The diff tab's title is `{recordType} {formKey}
  (Working Tree)`** — this is the one place the constructed identity string actually appears; the
  row itself, per Row presentation above, never shows it.
- **The committed-text provider fires `onDidChange`** on every refresh, for the union of
  committed-side URIs it showed before and after — a diff tab left open updates when a later
  refresh changes what's committed (a save-then-re-edit), or clears when the record drops out of
  the working-tree group entirely (reverted), rather than silently going stale.
- **Refresh is generation-guarded**: stage/save/revert can fire in quick succession, and two
  overlapping `refresh()` calls' own `GET /ledger/status` responses can resolve out of order. Only
  the result belonging to the most-recently-started call is ever applied; an older one that
  resolves later is discarded rather than overwriting newer state with stale state.
- **Refresh is event-driven**, wired into the same shared signal path every other pending-change
  provider uses (`refreshPendingState`, `modbench/src/medit/refreshPendingState.ts`) — the
  `SessionController` save/revert/create/copy/delete callback, the webview's `PENDING_CHANGED`
  message, and session load/exit. No polling, and no provider-specific call site: adding a new
  pending-change-aware provider (this one was the second, after `PendingChangeDecorationProvider`,
  #331) means adding it to that one function, not auditing every trigger by hand.
- **Read-only in this stage.** No staging, reverting, committing, or discarding from the panel — a
  resource's only affordance is its click-to-diff `command`. `RecordReverter` exists backend-side
  (#371) with deliberately no endpoint yet; this surface does not add one.

## Testing Decisions

- **Backend seam**: the API test host, observing real git repos through the real CLI (never
  mocked) — `LedgerStatusApiTests`. Includes the regression test for the `*.ledger/*` pathspec
  scoping: an origin folder's own ordinary files (plugin binary, `.bak`, `meta.ini`) must never
  appear as changes.
- **Frontend construction/diff seam**: Vitest, no backend — `LedgerScmProvider.test.ts` (resource
  shape, decorations, `FileDecorationProvider`, the diff command, the committed-text content
  provider) and `PluginRepository.test.ts` (wire-to-frontend mapping).
- **Shared refresh seam**: `refreshPendingState.test.ts` — the one place that proves every
  pending-change-aware provider (this one included) is refreshed together; the regression it
  guards against is a future provider (or call site) landing wired to only some of the others.
- **Integration seam** (`npm run test:integration`): command registration (`modbench.ledger.openDiff`
  in `EXPECTED_COMMANDS`) and that the provider constructs and its native registrations
  (`FileDecorationProvider`, `TextDocumentContentProvider`) hold with no session loaded. Proving
  the panel reflects a real stage/save/revert end-to-end needs a stateful backend, which the
  integration suite's mock server deliberately isn't — that behavior is proven at the shared
  refresh seam instead.

## Out of Scope

- **Staging, reverting, committing, or discarding from the panel** — read-only this stage.
- **Branch groups** (agent/script runs as open branches) — [ADR-0040](../adr/0040-git-native-pending-changes.md)
  stage 2, tracked as #378/#379/#380.
- **Routing a resource click to the compare grid in review mode** — #380. This stage's diff is
  always the native raw-text diff editor.
- **EditorID-resolved record labels** — plain FormKey for now; see Implementation Decisions.
- **Upstream anchors, drift detection** — later ADR-0040 stages (#382, #388), not read by
  this surface at all. Cross-repo atomic saves shipped with #372 (journaled prepare/advance
  behind `LedgerGroupCommitter.CommitGroupSaveAsync`, startup recovery replaying the journal —
  loud refusal on divergence, never a silent half-apply); also not read by this surface.

## Further Notes

- This surface does not retire the [Pending Changes tree](medit-pending-changes-tree.md) — the PRD
  that motivated this ticket calls that tree **superseded**, but retirement is
  [ADR-0040](../adr/0040-git-native-pending-changes.md) stage 3 (#383/#384), a deliberate later
  step, not a side effect of this one shipping. Both surfaces exist side by side today; the
  Pending Changes tree's own spec is unchanged by this document.
- The backend's `LedgerStatusQuery`/`GET /ledger/status` are specified here because this is their
  only consumer; `MEditService/CLAUDE.md`'s `Ledger/` folder entry covers the git-writing half
  (vendoring, commit) this surface only reads from.
