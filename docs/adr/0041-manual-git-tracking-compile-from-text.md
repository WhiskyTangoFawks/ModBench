---
status: accepted
---

# Tracking is manual, the repo lives in the mod folder, and Save & Compile writes the binary from source

Decided 2026-08-19 and refined through the "5 — Git-native editing" milestone. Together with
[ADR-0042](0042-plugin-is-the-source-of-truth-lossless-source.md) (what the source *is*) and
[ADR-0005](0005-reflection-driven-schema.md) (how the index is built from it), this is the
git-native editing model. Vocabulary: [CONTEXT.md](../../CONTEXT.md) § Load order & index.

## Context

Record editing needs an intermediate state between "the plugin as it was" and "the plugin as
the user wants it", plus review, revert, and history over that state. Two generations of
bespoke machinery (a staged pending-change model, then git shoehorned into that model — see
Alternatives rejected) each existed to make that intermediate state invisible and automatic,
and the automatism was the complexity. Adopting a git-native workflow as it is — a repo the
user creates on purpose, a working tree they edit, VS Code's own Source Control UI — collapses
nearly all of it.

## Decision

**Tracking is a manual, per-mod user gesture, and tracked *is* the presence of `.git` in the
mod folder.** No registry, no hidden gitdirs, no automatic repo creation. Stateless by
construction: a repo destroyed outside Modbench (MO2's Replace install shell-deletes the mod
folder) simply reads as untracked next time anyone looks. Folder rename/move carries the repo
with it; folder deletion is cleanup.

**Track = eager, complete serialization, gate-verified.** Track serializes *every* record of
the mod's plugins to the source tree (one root `source/` folder per mod, `source/<plugin>/…`
beneath it — no dot prefix, the plugin's source is first-class), verifies the round-trip gate
over the tree it just wrote (ADR-0042 — a plugin that does not round-trip is refused, naming
the record), commits the complete pristine state to `main`, then creates and checks out an
edit branch. Track is uniform — Modbench stores no Authored/Modified mode. A one-time,
progress-reported cost (~2.5 s for a 768 KB plugin including the gate; seconds for a
mega-plugin).

**Modified vs Authored is repo topology, not a mode.** A tracked downloaded mod keeps pristine
upstream state on `main` (never checked out in normal use) and the user works on the edit
branch; `git diff main <branch>` is "everything I changed", and checking out `main` and
compiling restores the pristine plugin. An authored mod merges into `main` at will. Provenance
is **commit trailers on `main` baselines** — `Binary-SHA256`, and `Upstream-Version` /
`Meta-SHA256` read from `meta.ini` as opaque bytes when present — informational, read by humans
and agents. Trailers may pre-select a dialog's default answer, never act without one.

**`meta.ini` is a source of trailers, never tracked content.** Mod-manager metadata mixes
provenance with mutable workflow state (one MO2 update check rewrites `lastNexusQuery` across
every mod); a tracked copy would mass-dirty every repo. General rule: never track a file that
changes for non-content reasons.

**Editing requires tracking; viewing never does.** Untracked plugins are hard read-only in the
editor, with signposting that names the Track command — deliberate friction on in-place editing
of someone else's plugin (the community's own anti-pattern; the blessed paths are a patch plugin
or a deliberate fork via Track). The read path — deep parse, conflict/winner, the compare grid
across the whole load order — never requires source.

**All edits write working-tree text; Save & Compile writes the binary.** The single write path
is edit → working-tree source → **Save & Compile**, which deserializes the source whole and
serializes the plugin binary. Compile behaves like a compiler: it derives what the format forces
it to derive (the masters list and renumber cascades — ADR-0038 stands), refuses only what it
structurally cannot emit (a FormKey held by more than one source unit, a state it cannot write
without silently renumbering), and reports everything else as Problems-panel diagnostics —
including the FormLink checks that validate at edit time against effective state. **Commit is
git's own gesture, ungated** — history may hold states that don't build. The gesture is
*named* "Save & Compile" so git-literate users aren't misled about what save does.

**Save & Compile snapshots to a parked ref, never to the branch.** Each compile records the
compiled working tree as a commit object (the `git stash create` mechanism — no HEAD, branch or
index movement) at `refs/medit/last-compile/<plugin>`, its message carrying a `Binary-SHA256`
trailer. This is "the binary as Modbench last wrote it": external-change detection and crash
recovery compare the on-disk binary against one ref read, the watcher uses it to ignore
Modbench's own writes, and no porcelain gesture (rebase, amend, squash) can move it. Track
initializes the ref to the pristine snapshot. A missing or orphaned ref degrades to asking the
user, never to guessing.

**Source is complete, and tracked plugins load from source.** The source contains everything
needed to compile the plugin, including the mod header (root `RecordData.json`). Reconcile
ingests a tracked plugin by deserializing its source whole — working tree → Effective, git
`HEAD` → Head — and never consults the binary for its content; untracked plugins keep the
binary ingest, producing the same document shape, so the read model never sees a dialect.
**Containment is the path**: a cell's place in the world is its directory, and compile reads
structure from the tree. The generated whole-mod serializer is the designated door for Track,
ingest and compile (always with a sequential dropoff); the per-record codec serves untracked
ingest, typed reads and point writes, byte-identical to the whole-mod door by test.

**Container source units are found by scanning the tree, never by computing a path.** A
path-computation grammar would be a second copy of the serializer's own directory-naming policy
and could only drift from it; `SourceUnitResolver` reads the disk (one group subtree per
lookup) — the one source that cannot drift. Head/Effective reconciliation of a container
likewise diffs two whole-mod deserializations structurally. Proposed and declined twice (#453,
#454); this paragraph is the standing answer.

**External change flows through one dialog.** A bridge assembly hosted in the backend process
(watch / deserialize / compile; knows nothing of load orders or the DB) plus the load-time hash
check observe a tracked binary changing outside Modbench. One dialog asks the only human
question: upstream update (pristine source committed to `main` as a new baseline, then an
offered rebase of the edit branch — clean replays proceed, conflicts open in VS Code's native
merge editor) or your own edit (working-tree dirt; commit or discard as usual). **Refusal
posture follows git**: an offered rebase over uncommitted dirt refuses, naming the paths;
commit/stash/discard are the user's gestures.

**The native git UI is the review surface.** The extension calls `vscode.git`'s
`openRepository(uri)` for each tracked mod in the load order (`extensionDependencies:
["vscode.git"]`): one native SCM group per tracked mod, native diffs, native commit. Git on
PATH is a stated product requirement (VS Code itself prompts to install it).

**Track generates the `.gitignore`, then the user owns it.** Two presets: **Edits** (everything
ignored except `source/`, the default for downloaded mods) and **Everything** (authoring: assets
tracked). Plugin binaries are ignored in both — the root plugin is the one plugin (ADR-0042).
Modbench never rewrites the file. Mod Management's deployer never deploys a dot-prefixed entry
at any depth, nor a root-level directory named `source` (case-insensitive; Papyrus ships
`Scripts/Source/…` nested, never at root, so nothing is lost).

**The index is built from the documents** — one `records` table holding each record's source
JSON, extracted index tables, generated `json_extract` views for filter SQL: ADR-0005.

## Consequences

- **The UX for tracking, compile and branches follows git and VS Code, not xEdit** — xEdit has
  no such model, so ADR-0034's carve-out is exactly this surface.
- **No provenance payload crosses contexts.** The boundary object stays origin + physical plugin
  path (ADR-0036). Mod Management never touches git or the backend; the backend learns
  everything by observation. Asset divergence stays Mod Management's Anchor concern; asset
  history (LFS) waits for a real need.
- **Agents and scripts are "another branch"** — merge = acceptance. Save & Compile serializing
  only the working tree is the one obligation that deferral imposes, and it holds anyway.
- **Accepted costs**: mod updates are manual git work structured by the topology; mega-plugin
  repos are heavy (~20k files / ~135 MB — hardlink deployment skips them); publishing a mod
  folder as an archive ships its `.git` unless excluded; the Everything preset bloats history
  with assets; ad-hoc SQL over arbitrary fields runs through `json_extract` views.
- **Timestamped `.bak` files (ADR-0008) are retained** until compile-from-source has soaked.
- **Layout changes re-Track.** There is no migration for an internal layout or format change:
  an already-tracked mod is re-Tracked (pre-alpha posture, stated in root `CLAUDE.md`).

## Alternatives rejected

- **The staged pending-change model (2026-07 → 2026-08-19).** A `pending_changes` table with
  per-field staged edits, validated at stage time, overlaid onto reads through generated views,
  grouped into derived dependency closures ("change groups") that gated commit, and shown in a
  bespoke Pending Changes tree; revert per field. Every piece was a home-grown reimplementation
  of a working tree, a diff and a commit, with its own storage, wire surface and UI to keep
  honest. Retired in full; the surviving fragment is compile-internal masters/renumber
  derivation, and edit-time FormLink validation as Problems-panel diagnostics.
- **Git-native *pending changes* (2026-08-15 → 2026-08-19).** Git adopted as the pending-change
  store but kept invisible: hidden external gitdirs keyed by hashed folder paths, automatic
  vendor-on-first-touch with lazy per-record baselines, a per-record truth partition, drift
  classification and provenance payloads crossing the context boundary, automatic rebase,
  lifecycle reconcilers and stale-gitdir sweeps, change-group closures gating commit, a bespoke
  aggregate SCM provider, and commit = save. Each existed to make git automatic; manual + eager
  tracking deletes them all, and the one-time Track cost is honest UX.
- **A parallel direct-binary write path for untracked mods** (xEdit-style load order memory +
  direct save) — friction on untracked editing is wanted, and a second write path forever is the
  shoehorn returning.
- **Standalone bridge process** — a second deployable and Mutagen load with IPC races, for no
  benefit: a watcher that's down misses nothing because the load-time hash check must exist.
- **Registry of tracked mods / wipe detection / bundle backups** — tracked = `.git` exists; git
  has no registry either. MO2 destroying a repo is an alpha-cohabitation hazard, not a scenario.
- **A repo nested inside the source folder** — breaks the Everything preset, splinters a
  multi-plugin mod into several repos, breaks one-repo-per-mod SCM identity.
- **Commit-to-the-branch on compile** (auto-commit per save, or compile refusing a dirty tree)
  — resurrects commit = save, spams history, multiplies rebase conflicts. The parked ref gives
  the same guarantee without touching the branch.
- **Change-group gating at commit** — git's own model is that history may hold non-building
  states; the only door where plugin validity is at stake is compile.
- **A container-path computation grammar** — see the scan-based decision above.
- **YAML source + the DuckDB community `yaml` extension** — a single-maintainer dependency in
  the hot query path, bought for prettier raw files. JSON is built in; one format everywhere.
- **Spriggit as serializer or as format specification** — ADR-0042.
