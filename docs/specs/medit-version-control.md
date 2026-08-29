# Version control — Surface Specification (Track, branch, compile)

**Status: Implemented.** Track (#414), the text-first edit path (#415), Save & Compile
(#416), external-change handling (#417), the editor gesture inventory (#426), the
lifecycle gestures (#427), record-row Modified/Added badges (#428), the closeout
truing (#418), crash recovery (#381), and New Plugin (#288) have all shipped.
Track is live end to end: preset QuickPick, progress-reported eager serialization, pristine
`main` with `Upstream-Version`/`Binary-SHA256`/`Meta-SHA256` trailers, checked-out `edit`
branch, parked `refs/medit/last-compile/<plugin>` ref, and native SCM registration via
`vscode.git` `openRepository`. Editing is live on the git-native model: a field edit writes
the record's working-tree source JSON (the single write path — scalar inline gesture in the
grid, plus `POST /records/{formKey}/field` for scripts/agents); the editor and compare grid
render working-tree values; reverting through git restores the committed value at the next
read (read-time freshness validation via `content_hash`, no watcher); untracked plugins are
hard read-only with signposting (`Modbench: Track…`, or the patch-plugin path for vanilla
masters). Save & Compile is live end to end: `modbench.saveAndCompile` (record-editor icon
resolving the active record's plugin, tree-row context menu, palette QuickPick fallback) and
`modbench.pluginListTree.compileAtMain` (row-only, behind a modal naming the ref) compile
source text to the binary through the journaled write pipeline — masters derived from content
in load order, container structure assembled from the index (`container_child` +
placement), typed refusals for unemittable states, diagnostics to the Problems panel on
success, per-repo `.git` journal markers (batch of one, `PendingRecovery` readable), and a
parked `refs/medit/last-compile/<plugin>` advance after every landed write, `AtRef`
included. External-change handling is live: the Bridge watcher and the load-time hash
check classify against the parked ref (self-echo suppressed, crash markers routed away
from this dialog), one modal per affected repo offers Absorb Upstream Update / Keep as My
Edit / defer-read-only (deferral refuses edits per-plugin until answered), Absorb commits
new baselines to `main` by plumbing and offers the rebase
(`modbench.pluginListTree.rebase` re-runs it; conflicts resolve in the merge editor and
the result compiles), and collisions with uncommitted dirt refuse naming the records.
The full editor gesture inventory is live on the same write path (#426): FormKey and
condition-function pickers (native QuickPick), flag multi-select, the extended-field
editor (#230 redirect), VMAD structural ops via the op-envelope through `EditField`, and
array add/remove/move (withheld on sorted arrays). Lifecycle gestures are live (#427),
on the Plugins-tree context menus with xEdit's own captions (Add / Remove / Change
FormID…): create allocates the next-free FormID collision-safe against both refs and
lands as a working-tree source file (absent at Head; rediscovered at session load if
uncompiled), delete confirms modally and removes the source file (still served at Head),
renumber is a delete+create pair with a cross-repo reference cascade — referencing repos
write first, the target last, any untracked referencer refuses up front, and a typed
refusal covers overrides, collisions, and FormKey-space exhaustion. Record-row dirty
badges are live (#428): `RecordSummary.WorkingTreeState` (`Search()`'s own `"ref"` plus a
`records_committed` presence check — None/Modified/Added) reaches the Plugins tree, whose
`RecordNode`s carry a synthetic `medit-record:/<plugin>/<origin>/<formKey>` resourceUri
(path-only, no authority — identity only, never state — deliberately not the real source
path, which would double against `vscode.git`'s own decoration on the same tracked file)
for a `FileDecorationProvider` to badge M/A with git's own
`gitDecoration.modifiedResourceForeground`/`addedResourceForeground` colours. A field edit
patches the one cached record (never downgrading a still-uncommitted create's Added to
Modified) and fires the decoration event for just that URI rather than a tree-wide
refresh. A Modbench edit itself prompts the edited plugin's own `Repository.status()`
(#557), so the native Source Control panel picks up the resulting working-tree change
without a manual Refresh click — the extension does retain a `Repository` handle from
`openRepository` for this outbound direction. But committing or reverting through the
native Source Control panel still pushes no live signal to these badges: nothing yet
subscribes to that same `Repository`'s `state.onDidChange`, so a badge set by a
Modbench-driven edit only clears (or a badge a native commit/revert should have changed
only updates) at the next Modbench-driven read, the same no-watcher posture the record
editor and compare grid already carry. Deleted is
out of scope (follow-up filed separately): `Search()` is Effective-only, so a
working-tree-deleted record has no row to badge at all — the same way VS Code's own
Explorer drops a deleted file's row rather than badging it; the native Source Control
panel already shows that D for free. This is the Track/Compile surface spec the
milestone-5 rebuild names ([ADR-0041](../adr/0041-manual-git-tracking-compile-from-text.md)
and its 2026-08-19 amendment; PRD #366; UX contract pinned on #417) — it replaces the
retired aggregate-SCM and Pending Changes tree specs, both deleted by #418's closeout.

Editing context — operates on **records**, **FormKeys**, **plugins**, and **tracked mods**
(glossary: Tracked mod, Track, Source, Edit branch, Baseline, Save & Compile, Working-tree
change — [CONTEXT.md](../../CONTEXT.md)). "Tracked mod" is deliberately admitted Editing
vocabulary: tracking is a property of the mod *folder* (where `.git` lives), while every
other gesture here operates on plugins and records.

**The UX reference is git and VS Code, not xEdit** (ADR-0034's recorded exception — xEdit
has no pending-change model). Where a gesture exists in VS Code's own git experience, this
surface copies it; Modbench invents nothing the platform already renders.

## Problem Statement

ADR-0041 makes editing a git-native workflow: a mod is tracked by an explicit gesture, its
records live as per-record JSON text in an in-folder repository, edits are working-tree
changes, and the plugin binary is a compiled artifact. That model needs a user-facing
surface for exactly four moments: deciding to track, reviewing and committing changes,
compiling text back to the binary, and answering for a binary that changed outside
Modbench. Everything between those moments is VS Code's own git UI, which this spec
deliberately does not duplicate.

## Solution

Four gestures on native surfaces, plus the platform's own Source Control panel doing the
review work:

| Moment | Surface |
| --- | --- |
| **Track** | Plugin-row context menu / palette → preset QuickPick → progress notification |
| **Review & commit** | VS Code's native Source Control panel, one repo group per tracked mod (`vscode.git` `openRepository`) |
| **Save & Compile** | Command from the record editor, plugin row, and palette; diagnostics to the Problems panel |
| **External change** | One modal dialog per affected repo; rebase offer as a follow-up notification |

## The workflows

The point of this surface is to express mod editing in terms of git workflows that
already exist. Nothing below is enforced, stored, or branched on (ADR-0041 amendment:
Track is uniform; Authored vs Modified is workflow, not a mode) — each is an ordinary git
topology the user drives with ordinary git gestures, and drifting between them is just
using git.

- **Modify a downloaded mod** — the maintain-a-patch-branch workflow. Track (Edits
  preset); pristine upstream sits on `main`, never merged into and never checked out in
  normal use; all work happens on the edit branch. Edit → review dirt in the panel →
  commit → Save & Compile → test in game, repeat. `git diff main <branch>` stays
  "everything I changed against upstream" for exactly as long as `main` stays pristine —
  which is this workflow's one discipline, kept by the user, not by Modbench.
- **Take an upstream update** — a standard rebase: the branch stands still, `main` moves
  under it. The update lands as an external binary change; `Absorb Upstream Update`
  commits the new pristine state to `main` as new baselines, and the offered rebase is
  `git rebase` with the platform's merge editor for conflicts. Uncommitted dirt refuses
  the rebase exactly as git would — commit, stash, or discard first is ordinary git
  hygiene, not a Modbench rule. Under the Everything preset the update also overwrites
  tracked assets in place, arriving as working-tree changes to be sorted with the same
  gestures.
- **Author a mod** — feature-branch-and-merge, the default workflow of every codebase.
  Identical to modifying with one difference: the user merges the edit branch into `main`
  at will, because `main` is the release line, not a pristine record. Nothing selects
  this — it is simply what merging to `main` means, and the first merge is the moment a
  mod stops having a pristine baseline to diff against.
- **Review an agent's changes** — reviewing a contributor's diff. Every edit, whether a
  human's, a script's, or an agent's, lands as working-tree dirt; nothing becomes history
  until someone commits. The panel is therefore the review gate for agentic work by
  construction — inspect the diff, revert the wrong, commit the accepted — with commit as
  the acceptance gesture. (Agent runs as branches with merge = acceptance is the deferred
  richer form; this is the mechanism that ships now.)

## User Stories

1. As a user, I want to track a mod with one explicit gesture and a clear preset choice, so
   that forking someone's plugin is a decision I make, never something that happens to me.
2. As a user, I want an untracked plugin to be visibly read-only with the way out named, so
   that I understand the friction is deliberate and one command away from gone.
3. As a git-literate user, I want my changes reviewed, diffed, committed, branched, and
   reverted in VS Code's own Source Control panel, so that nothing I already know stops
   being true here.
4. As a user, I want Save & Compile to write the binary from my working tree and tell me
   everything wrong as diagnostics — refusing only what it structurally cannot emit — so
   that saving feels like building, and committing stays mine.
5. As a user, I want `git diff main <branch>` to be "everything I changed against pristine
   upstream", so that my fork is inspectable and redistributable by construction.
6. As a user, I want a binary that changed outside Modbench to surface one question —
   upstream update or my own edit — with the likely answer pre-selected, so that xEdit
   sessions and mod updates both have a safe, obvious path back in.
7. As a user, I want an upstream update to land as new baselines with a rebase I can take
   now or later, conflicts opening in the merge editor I already know, so that updating a
   forked mod is ordinary git work, structured for me.
8. As a user, I want a corrupt or stale binary detected at load with a loud offer to
   rebuild it from my text, so that a crash never silently costs me work.
9. As a user, I want edits made by an agent or script to land as ordinary working-tree
   changes, so that I review, revert, or commit them in the panel like any contributor's
   diff before they become history.

## The surfaces

### New Plugin

- **Where**: the Plugins tree's navigation bar (`modbench.newPlugin`) and the command palette.
  Prompts for a name (`.esp`/`.esm`/`.esl`, xEdit's own extensions), then a destination
  QuickPick: **overwrite/** (default — first in the list, so Enter alone accepts it, preserving
  the xEdit-under-MO2 reflex), **an existing mod** (searchable — native QuickPick filtering),
  or **a new mod** (name prompt; creates the mod folder itself via the same install path
  `modbench.modList.installFromFolder` uses, with an empty source directory — the mod
  registers in `modlist.txt` and the Mods tree exactly as any other install does, disabled by
  default until the user enables it, same as every other install).
- **Creation is Editing's job, participation is Mod Management's** (#288, an unwritten
  implication of ADR-0035 — the two contexts still never share a payload beyond origin + path,
  ADR-0036). The backend writes the binary, Tracks the destination under the **Edits** preset
  if it is not already tracked (silently — no second preset prompt; the destination QuickPick's
  one-keystroke framing rules out one, and Edits is Track's own default. A user wanting a
  different preset deletes `.git` and re-Tracks by hand, the same gesture Track always offered),
  and indexes the plugin. Only once that has actually succeeded does the extension's
  composition root call a new Mod Management writer (`IModlistSource.appendPlugin`,
  `modmanager/mo2/pluginsText.ts`) that appends an enabled entry line at the winning end of
  `plugins.txt`. This ordering is the whole of the surface's own invariant: `plugins.txt` can
  never name a file that does not yet exist, because nothing writes the line until the file and
  its index entry are already real.
- **A created plugin is ordinary working-tree text on its destination mod's edit branch** — no
  Authored mode, no provenance flag. "Authored" is what merging to `main` at will already means
  (ADR-0041 amendment); a created plugin arrives no differently than any other tracked edit.
- **Accepted residue, not rolled back** (#288 review): the "new mod" destination registers the
  mod folder in `modlist.txt` (via the ordinary install path) *before* the create call that
  writes the plugin into it, so a backend failure on that call leaves an empty, disabled, but
  registered mod behind — visible in the Mods tree, harmless, and the user's own delete undoes
  it. Deliberate, the same posture the mega-plugin Track cost and every other accepted cost in
  this spec already takes: named, not engineered around.

### Track

- **Where**: a plugin row's context menu (Plugins tree) and the command palette. The
  command tracks the plugin's *mod folder* — one repo per mod, covering all its plugins.
- **Preset QuickPick**: **Edits** (default — everything ignored except `source/**`, the
  one root folder holding every tracked plugin's own tree — #441)
  or **Everything** (authoring — assets tracked too). Plugin binaries are ignored in both;
  the `.gitignore` is generated once and then owned by the user (ADR-0041).
- **Progress**: eager, complete serialization is progress-reported (typically sub-second;
  ~21 s worst-case mega-plugin). On completion the repo exists with the pristine baseline
  on `main` (provenance trailers: `Upstream-Version`, `Binary-SHA256`, `Meta-SHA256`, all
  optional, read from `meta.ini` as opaque bytes), the edit branch checked out, and the
  parked ref initialized — and the mod appears in the Source Control panel.
- **The `source/` folder's lifecycle, in one place** (#441): Track is what creates it —
  eager serialization writes `source/<plugin>/…` for every plugin Track covers, the moment
  Track runs. The edit path (field edits, create/delete/renumber) writes into an
  already-tracked plugin's own tree under it. Compile reads from it (working tree or a
  named ref). No other gesture creates or deletes the folder or a plugin's tree inside
  it — untracking is deleting `.git` by hand, which leaves the folder exactly where it
  is (never assume exclusive ownership); there is no separate cleanup or migration step.
- **Track is uniform** (ADR-0041 amendment): no Authored/Modified mode is chosen or
  stored. "Authored" is the workflow of merging into `main` at will.
- **Untrack is not a command** — deleting the `.git` folder is the gesture (git itself
  has no registry either). The mod reads as untracked at the next look, no residue, no
  prompt, nothing to clean up.
- **Untracked read-only signposting**: edit gestures on an untracked plugin are refused
  with a message naming the Track command — except plugins with no mod folder (vanilla and
  DLC masters), whose refusal signposts the blessed path instead: author a patch plugin.
  No silent dead UI in either case.
- **No half-repo on failure** (#414, cleanup broadened by #508): a Track that fails partway
  leaves the mod folder exactly as if Track were never attempted — `.git`, `.gitignore` and
  the partially-written `source/` tree are all removed on any failure, not just `.git`. One
  catch block wraps the whole init→checkout sequence, so cleanup is uniform regardless of
  which step failed.
- **Localized plugins** (#515): Track, Compile and session ingest resolve `TranslatedString`
  values from the plugin's own mod-folder `Strings/` folder first, then the game Data
  folder — every deep parse passes an explicit strings lookup rather than relying on
  Mutagen's own game-listings fallback (which throws on non-Windows hosts with no
  `LocalAppData`). A Localized plugin missing an expected strings file is refused naming
  the specific missing filename. Compile writes a tracked Localized plugin's strings back
  beside the compiled plugin — through the same temp-write-then-rename discipline as the
  `.esp`/`.esm` itself (#537): strings are produced into the plugin's temp dir during prepare
  (a failed prepare never touches the real `Strings/` files) and moved into place only by the
  same commit step that renames the plugin. The move step is per-file, not a cross-file
  transaction — a crash mid-commit can still pair a committed plugin with partially-updated
  strings, a documented residual gap (full atomicity was rejected as overengineering in
  ADR-0008's single-file case already). No `.bak` is taken for strings files; ADR-0008's
  backup discipline stays scoped to the target plugin.

### Review & commit: the native Source Control panel

- The extension calls `vscode.git`'s `openRepository(uri)` for each tracked mod in the
  loaded session, re-registered on every activation (`extensionDependencies:
  ["vscode.git"]`; git on PATH is a product requirement — VS Code itself prompts to
  install it). One native repo group per tracked mod. Modbench contributes **no** SCM
  provider, resource groups, decorations, or diff commands of its own here — the retired
  aggregate SCM provider (formerly `scm.md`) has no shim.
- Everything the panel offers is git's own: staging, commit, discard, branch switching,
  history. Commit is ungated (ADR-0041) — no closure checks, no prompts, no vocabulary of
  ours on the panel.
- Source diffs are readable by construction: canonical JSON formatting (#412 — stable key
  order, fixed indentation) means a one-field edit is a one-line diff.
- **Branch gestures have honest consequences, not guards.** Checking out any ref —
  `main` included — changes the working-tree text, and every editing surface follows it
  at the next read (#413 read-time freshness). The binary does not change until Save &
  Compile: a checkout is never an implicit compile, and the panel's state is always the
  true state. Merging the edit branch into `main` (the Authored workflow) is the same
  ordinary gesture.
- **Git fluency outside the panel is tolerated by construction.** The terminal, another
  git client, history rewriting (amend, squash, interactive rebase) — all absorbed the
  same way, because nothing assumes Modbench performed the git action: editing surfaces
  validate freshness at read time, and detection state lives in refs (`refs/medit/*`)
  that no porcelain gesture rewrites.
- `refs/medit/*` (the parked compile snapshots) never appear in the panel or in any
  porcelain surface; they are mechanics, not UX.

### Working-tree state in the editing surfaces

- The record editor and compare grid render **Effective** state — committed text with
  working-tree changes overlaid (#413 contract); reverting a file through the panel
  restores the committed value at the next read.
- Record rows carrying working-tree changes are badged with git's own single-letter
  vocabulary via `FileDecorationProvider` — the same idiom, the same letters, as every
  git-decorated surface in VS Code (#428). `M` (edited existing record) and `A` (created,
  no committed counterpart) ship; `D` does not — `Search()` (what the Plugins tree lists)
  is Effective-only, so a working-tree-deleted record has no row to badge at all, the same
  way Explorer drops a deleted file's row rather than badging it. The native Source Control
  panel already shows that D for free.

### Save & Compile

- **Where**: command from the record editor, a tracked plugin's context menu, and the
  palette. The gesture is named **Save & Compile** in full, so save is never mistaken for
  commit.
- **Target resolution from the palette** (no tree row, no active record): falls through to
  a QuickPick over every loaded plugin. Any failure resolving a target — including the
  backend being unreachable (before Launch mEdit) — reports a clear Modbench-authored
  error and ends quietly, never VS Code's raw "fetch failed" toast (#505/#530).
- **Behavior** (#416 pinned contract): serialize the plugin's working tree to the binary
  through the journaled pipeline (timestamped `.bak` per ADR-0008). Masters are derived
  from content and written in current plugin load order. Semantic breakage (dangling
  FormLinks and kin) compiles *successfully* with diagnostics published to the Problems
  panel against the source files; only structurally unemittable states refuse, as a typed
  message naming the reason — including states that cannot be emitted without changing
  FormKeys (no silent renumber; ADR-0041 amendment).
- **Compile at `main`**: compiling at ref `main` (no checkout — the edit branch and its
  dirt are untouched) writes the binary as `main` has it, behind one confirmation. In the
  Modified workflow that is the pristine restore; in the Authored workflow it rebuilds
  the release line. No mode is stored, so the confirmation names the ref, never
  "pristine".
- Each compile parks a snapshot commit at `refs/medit/last-compile/<plugin>` — invisible
  here, load-bearing for the dialog below and for crash repair.

### External change: the one dialog

Pinned in full on #417; summarized here. When a tracked plugin's binary changes outside
Modbench (bridge watcher live, hash check at load — both compare against the parked ref):

- **One native modal per affected mod repo**, queued sequentially when several changed —
  never a mega-dialog. Message names the plugin and mod folder; detail states what was
  observed, and shows the evidence when the meta tell fired (`meta.ini also changed
  (version <old> → <new>)`).
- **Buttons**: `Absorb Upstream Update` / `Keep as My Edit` / Esc. The default (first)
  button follows the `Meta-SHA256` compare — trailers may inform defaults, never actions
  (ADR-0041 amendment); the human always answers. The dialog is uniform across
  workflows: for an authored mod's own xEdit session the meta tell doesn't fire and the
  default is already `Keep as My Edit`.
- **Absorb Upstream Update**: new baselines committed to `main` by plumbing (no checkout,
  fresh trailers), then a non-modal notification offers the rebase (`Rebase Now` /
  `Later`). Absorb commits to `main` as it stands: if the user has merged into `main`
  (the Authored workflow), there is no pristine left to diff against — that is the
  topology they chose, not a state Modbench detects or repairs. Rebase with any uncommitted dirt refuses, naming the paths — commit, stash, or
  discard is the user's move, then re-run via `Modbench: Rebase onto Updated Baseline`.
  Conflicts open in VS Code's native merge editor on the source JSON.
- **Keep as My Edit**: the change deserializes into working-tree dirt on the affected
  records — commit or revert as usual. A same-record collision with existing uncommitted
  dirt refuses first, naming the records.
- **Esc = defer, per-plugin read-only**: nothing is written; the plugin refuses edits
  (signposting the pending question) until answered; reads keep serving last-known state;
  the question re-asks at next detection or load.
- A destroyed repo (MO2 Replace install) is **not** this dialog — the mod reads as
  untracked, per ADR-0041.

### Crash recovery (#381)

(Glossary term: *Crash recovery* — "crash repair" survives as the code/API name. *Repair* now means malformed-plugin repair, [medit-repair.md](medit-repair.md).)

Live: the load-time hash check (`ExternalChangeSessionHook`, shared with #417) covers two
states on every tracked plugin, both detected only at session load — the only moment either
can newly arise, since one is this same process's own interrupted compile and the other is a
read failure a running session would already have hit once. A pending `CompileJournal` marker
(a crash, or a kill, between the binary write landing and the marker clearing) classifies as
`CrashRecovery` and routes here, never to #417's dialog — the two prompts never both fire for
one event, checked at the classifier itself before any hash compare. A tracked plugin's binary
that cannot be read at all (deleted, moved, or torn, while the mod folder and its repo
survive — distinct from the repo itself being destroyed, which reads as untracked per
ADR-0041 and is a different path entirely) is caught directly, with nothing to classify
against. Both surface identically to the extension as `CrashRepairOffer`s riding
`POST /session/load[-explicit]`'s own response (`SessionLoadResponse.CrashRepairOffers`,
the same structured-failures posture `Failures` already has, ADR-0026) — no second endpoint,
no poller: a session load already observes both triggers.

One native modal per offer, sequential, run once right after a completed load settles the
tree: **Compile from Working Tree** (default/first — an interrupted compile means the user
was compiling their own working tree, and there is no meta-style tell here to justify a
cleverer default) or **Compile at main**, composing Save & Compile's existing tail
(`compileAndReport`) rather than a second compile path — accepting either button is the same
call `saveAndCompile`/`compileAtMain` already make. The detail text names exactly what was
detected (interrupted compile vs missing/unreadable binary), the evidence shown, not hidden,
same posture as #417's own dialog. Esc/dismiss is a true decline: nothing is written, the
marker or missing binary stays exactly as it is, editing stays live throughout (text at `main`
is authoritative for tracked records regardless of binary staleness — nothing gates edits on
this state), and the offer re-appears at the next session load by construction. Untracked
plugins are never probed at all.

## Implementation Decisions

- **Contracts are pinned on the slices**, not restated here: the Index seam and
  `content_hash` (#413), the repo-layer verbs and their error modes (#414), `Compile` and
  `CompileResult` (#416), the dialog UX (#417). This spec is the user-facing composition
  of those contracts.
- **Tracked = `.git` exists.** No registry, no reconciliation sweeps; every surface above
  tolerates the repo having vanished since last observed and reads the mod as untracked.
- **Track pins repo-local git config** — `core.autocrlf=false` at minimum (the
  byte-equality invariant depends on it); identity fallback and `commit.gpgsign` handling
  are decided in-slice (#414).
- **`meta.ini` is a source, never content**: read for trailer values at baseline moments,
  never committed (ADR-0041 amendment — never track a file that changes for non-content
  reasons).
- **Refusal posture is git's**: refuse and the user fixes it — rebase-over-dirt,
  deserialize-over-dirt, renumber-forcing compiles. Automation on top may come later;
  none of it is in this milestone.

## Testing Decisions

- Backend seams test against **real git repositories through the real CLI** (the house
  pattern the retired aggregate SCM provider established); fixtures verify the full Track
  product — source, baseline, trailers, `.gitignore`, branch, parked ref — and compile
  round-trips re-parse clean (round-trip gate #369, permanent —
  `BinaryRoundTripGateTests`/`CompileRoundTripGateTests`,
  `MEditService.Tests/RealData/`, run in the ordinary `dotnet test`).
- **Track's round-trip gate also catches subrecord loss the model can't see** (#514): Mutagen's
  parse occasionally drops a subrecord silently (a malformed length field desyncing the parser,
  a duplicate-slot collision) — invisible to the model-identity check, since the in-memory model
  never held what was dropped. A byte-level walk (`MEditService.Core/Source/PluginBinaryWalk.cs`,
  Mutagen-free) compares the original and recompiled binaries' subrecord signatures per record;
  any signature occurring fewer times in the rewrite is refused naming the record type, FormID
  and dropped signature(s) (more occurrences — a canonical marker insertion — is not a refusal).
  One exemption (#563): a TES4 record's `MAST`/`DATA` pair dropping is ADR-0038's sanctioned
  master-list pruning, not a loss — Mutagen unconditionally re-derives the header's master list
  from live content on every write, so this exact signature pair is excluded from the check (72%
  of all real Track refusals in the one available real-world corpus, before this exemption).
  Compile has no independent binary to diff against and gets no live version of this gate; the
  guarantee is inherited transitively, since this loss class can only be introduced by
  deserializing an external binary, which happens at Track, never Compile.
- The dialog's paths are fixture-driven per #417's acceptance criteria, including the
  upstream fixture arriving the only way it can while `.git` survives (Merge install /
  manual overwrite).
- Integration suite: every command above in `EXPECTED_COMMANDS`; activation with several
  tracked mods (including the mega fixture) measured for the steady-state
  `openRepository` cost (#414).

### ADR-0041 gates — standing state (#418)

- **Filter probe verdict** — settled on
  [#366](https://github.com/WhiskyTangoFawks/ModBench/issues/366): #411's real-corpus
  probe found the generated `json_extract` views comfortably fast once the filter is
  materialised once per apply rather than evaluated per query, so no field is promoted to
  a real extracted column. See #366's probe comment and its follow-up correction for the
  full measurement.
- **Round-trip gate** — `BinaryRoundTripGateTests` and `CompileRoundTripGateTests`
  (`MEditService.Tests/RealData/`), permanent per #369, exercised on every `dotnet test`.
- **Mutagen pin** — `Mutagen.Bethesda.Fallout4` is pinned at an exact version (not a
  floating range) in `MEditService.Core.csproj`; the pin comment there records the
  `ObjectTemplate`/`refr.Base` regression the pinned version avoids and names #385 as the
  upstream-fix tracking issue that gates moving off it.

## Out of Scope

- **Agent/script runs as branches, merge = acceptance** — deferred milestone; compatible
  by construction (branching is the core idiom).
- **Grid review mode** for diffs (#380) — the native text diff is this milestone's answer.
- **LFS / asset-history management** — waits for a real need (Everything-preset history
  bloat is a recorded accepted cost).
- **Managed installation** — roadmap (milestone 10); it pre-answers the dialog and writes
  trailers firsthand, changing sources, not this surface.
- **Editor-level partial undo** (one field among several edits to the same record file) —
  git's whole-file discard is the granularity this milestone ships.
- **Remotes** — push, pull, hosting: nothing prevents a user adding a remote to a
  tracked mod's repo; nothing in the product reads or writes one.
- **Mod lineage identity across re-tracks** — ruled out until a consumer exists (#413
  addendum).

## Further Notes

- ADR-0002 stands amended for tracked mods only: text is the working source, the binary
  remains the interchange truth with external tools — which is exactly why the dialog
  exists.
