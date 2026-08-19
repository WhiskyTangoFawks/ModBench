# Version control — Surface Specification (Track, branch, compile)

**Status: Designed, not yet implemented.** This is the Track/Compile surface spec the
milestone-5 rebuild names ([ADR-0041](../adr/0041-manual-git-tracking-compile-from-text.md)
and its 2026-08-19 amendment; PRD #366; UX contract pinned on #417). It is written ahead of
implementation deliberately — the closeout slice (#418) trues it up to **Implemented**,
folds in what shipped, and deletes the two specs this document replaces:
[scm.md](scm.md) (aggregate SCM provider) and
[medit-pending-changes-tree.md](medit-pending-changes-tree.md) (Pending Changes tree).
Until then, discrepancies between this document and running code are expected and resolve
in this document's favor only once the relevant slice lands.

Editing context — operates on **records**, **FormKeys**, **plugins**, and **tracked mods**
(glossary: Tracked mod, Track, Ledger, Edit branch, Baseline, Save & Compile, Working-tree
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

### Track

- **Where**: a plugin row's context menu (Plugins tree) and the command palette. The
  command tracks the plugin's *mod folder* — one repo per mod, covering all its plugins.
- **Preset QuickPick**: **Edits** (default — everything ignored except `<plugin>.ledger/**`)
  or **Everything** (authoring — assets tracked too). Plugin binaries are ignored in both;
  the `.gitignore` is generated once and then owned by the user (ADR-0041).
- **Progress**: eager, complete serialization is progress-reported (typically sub-second;
  ~21 s worst-case mega-plugin). On completion the repo exists with the pristine baseline
  on `main` (provenance trailers: `Upstream-Version`, `Binary-SHA256`, `Meta-SHA256`, all
  optional, read from `meta.ini` as opaque bytes), the edit branch checked out, and the
  parked ref initialized — and the mod appears in the Source Control panel.
- **Track is uniform** (ADR-0041 amendment): no Authored/Modified mode is chosen or
  stored. "Authored" is the workflow of merging into `main` at will.
- **Untrack is not a command** — deleting the `.git` folder is the gesture (git itself
  has no registry either). The mod reads as untracked at the next look, no residue, no
  prompt, nothing to clean up.
- **Untracked read-only signposting**: edit gestures on an untracked plugin are refused
  with a message naming the Track command — except plugins with no mod folder (vanilla and
  DLC masters), whose refusal signposts the blessed path instead: author a patch plugin.
  No silent dead UI in either case.

### Review & commit: the native Source Control panel

- The extension calls `vscode.git`'s `openRepository(uri)` for each tracked mod in the
  loaded session, re-registered on every activation (`extensionDependencies:
  ["vscode.git"]`; git on PATH is a product requirement — VS Code itself prompts to
  install it). One native repo group per tracked mod. Modbench contributes **no** SCM
  provider, resource groups, decorations, or diff commands of its own here — the
  aggregate provider (scm.md) retires with no shim.
- Everything the panel offers is git's own: staging, commit, discard, branch switching,
  history. Commit is ungated (ADR-0041) — no closure checks, no prompts, no vocabulary of
  ours on the panel.
- Ledger diffs are readable by construction: canonical JSON formatting (#412 — stable key
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
  vocabulary (`M`/`A`/`D`) via `FileDecorationProvider` — the same idiom, the same
  letters, as every git-decorated surface in VS Code. Derivation is the Index's
  byte-compare (`content_hash`); presentation details are slice-level (#415).

### Save & Compile

- **Where**: command from the record editor, a tracked plugin's context menu, and the
  palette. The gesture is named **Save & Compile** in full, so save is never mistaken for
  commit.
- **Behavior** (#416 pinned contract): serialize the plugin's working tree to the binary
  through the journaled pipeline (timestamped `.bak` per ADR-0008). Masters are derived
  from content and written in current plugin load order. Semantic breakage (dangling
  FormLinks and kin) compiles *successfully* with diagnostics published to the Problems
  panel against the ledger files; only structurally unemittable states refuse, as a typed
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
  Conflicts open in VS Code's native merge editor on the ledger JSON.
- **Keep as My Edit**: the change deserializes into working-tree dirt on the affected
  records — commit or revert as usual. A same-record collision with existing uncommitted
  dirt refuses first, naming the records.
- **Esc = defer, per-plugin read-only**: nothing is written; the plugin refuses edits
  (signposting the pending question) until answered; reads keep serving last-known state;
  the question re-asks at next detection or load.
- A destroyed repo (MO2 Replace install) is **not** this dialog — the mod reads as
  untracked, per ADR-0041.

### Crash repair (#381)

A journal marker present at load means the mismatch is Modbench's own interrupted
compile: that routes to a loud detect-and-offer (rebuild the binary from the working tree,
or from `main`, user's choice) — never to the external-change dialog. The two prompts
never both fire for one event.

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
  pattern scm.md established); fixtures verify the full Track product — ledger, baseline,
  trailers, `.gitignore`, branch, parked ref — and compile round-trips re-parse clean
  (round-trip gate #369, permanent).
- The dialog's paths are fixture-driven per #417's acceptance criteria, including the
  upstream fixture arriving the only way it can while `.git` survives (Merge install /
  manual overwrite).
- Integration suite: every command above in `EXPECTED_COMMANDS`; activation with several
  tracked mods (including the mega fixture) measured for the steady-state
  `openRepository` cost (#414).

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
- The Pending Changes tree and aggregate SCM provider specs remain accurate descriptions
  of shipped behavior until #410 removes the machinery; #418 deletes both specs and
  flips this one to Implemented.
