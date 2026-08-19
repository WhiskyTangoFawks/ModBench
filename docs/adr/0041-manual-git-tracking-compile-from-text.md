---
status: accepted
---

# Tracking is manual, the repo lives in the mod folder, and save compiles from text

Supersedes [ADR-0040](0040-git-native-pending-changes.md) and both of its 2026-08
amendments. Decided in the 2026-08-19 design conversation (grilled to closure); the
migration epic is the rebuilt milestone "5 — Git-native editing".

## Context

ADR-0040 adopted git as the pending-change store, but shoehorned it: hidden external
gitdirs keyed by hashed folder paths, automatic vendor-on-first-touch, a per-record
truth partition, provenance machinery classifying drift, change-group closures gating
commits, and a bespoke aggregate SCM provider re-rendering what git already knows. Each
piece existed to make git invisible and automatic. Working the model through again from
"adopt a git-native workflow, don't pour our concepts into git" showed that the
automatism was the complexity: making tracking a deliberate user gesture collapses
nearly all of it, and lets the platform's own git surfaces replace our hand-rolled ones.

## Decision

**Tracking is a manual, per-mod user gesture, and tracked *is* the presence of `.git`
in the mod folder.** No registry, no hidden gitdirs, no automatic repo creation.
Stateless by construction: a repo destroyed outside Modbench (e.g. MO2's Replace
install, which shell-deletes the whole mod folder) simply reads as untracked next time
anyone looks — nothing detects it, nothing backs it up. Folder rename/move carries the
repo with it; folder deletion is cleanup.

**Track = eager, complete serialization.** The Track command serializes *every* record
of the mod's plugins to per-record JSON files (`<plugin>.ledger/**`, one record = one
file, container-shaped records stripped shallow per #387), commits the complete
pristine state to `main`, then creates and checks out an edit branch. There is no lazy
per-record vendoring and no per-record truth partition: a tracked mod's text is
complete — text is the source, the binary is the compiled artifact. A one-time
progress-reported cost at track (worst case ~21 s for a 20 MB mega-plugin; typically
sub-second) buys the removal of first-touch choreography, tracked-record-set
bookkeeping, and the partial-apply write path.

**Modified vs Authored is repo topology.** A tracked downloaded mod keeps pristine
upstream state on `main` (never checked out after track) and the user works on the
edit branch; `git diff main <branch>` is "everything I changed", and checking out
`main` + compiling restores the pristine plugin. An Authored mod works on `main`
directly — there is no pristine to preserve. Provenance is **commit trailers on `main`
baselines** (binary SHA-256, upstream version string): informational, greppable, read
by humans and agents — never by classification machinery.

**Editing requires tracking; viewing never does.** Untracked mods are hard read-only in
the editor, with signposting that names the Track command — deliberate friction on
in-place editing of someone else's plugin (the community's own anti-pattern; the
blessed paths are authoring a patch plugin, or deliberately forking via Track). The
read path — deep parse, conflict/winner, compare grid across the whole load order —
is unaffected and never requires text.

**All edits write working-tree text; "Save & Compile" writes the binary.** The single
write path is: edit → working-tree JSON → **Save & Compile**, which serializes the
working tree to the plugin binary. Compile behaves like a compiler: it derives what the
format forces it to derive (the masters list — FormIDs cannot be encoded without it,
ADR-0038 stands), refuses only what it structurally cannot emit, and reports everything
else as diagnostics. Commit is git's own gesture, untouched and ungated — committing a
half-finished state is committing code that doesn't build yet. The gesture is *named*
"Save & Compile" so git-literate users aren't misled about what save does.

**Change groups are retired as a concept.** No closure gating on commit or save.
Dependency validation becomes ordinary diagnostics (the ADR-0020 check engine
publishing to the Problems panel against the ledger text); the one non-optional residue
of closure computation — masters derivation and renumber cascade — lives inside
compile, where plugin validity is actually at stake.

**External change flows through one dialog.** A standalone bridge assembly (hosted in
the existing backend process — watch / deserialize / compile, knowing nothing of
sessions or the DB) plus the load-time hash check observe a tracked binary changing
outside Modbench. One dialog asks the only human question: upstream update (pristine
text committed to `main` as new baselines via plumbing, then an offered rebase of the
edit branch — clean replays proceed, conflicts open in VS Code's native merge editor)
or your own edit (working-tree dirt, commit or revert as usual). Managed installation,
when it lands, pre-answers the dialog; the architecture doesn't change.

**The native git UI is the review surface.** The extension calls the `vscode.git` API's
`openRepository(uri)` for each tracked mod in the loaded session (re-registered per
activation; `extensionDependencies: ["vscode.git"]`): one native SCM group per tracked
mod, native diffs, native commit. The bespoke aggregate SCM provider retires with no
fallback shim. Git on PATH becomes a stated product requirement (VS Code itself prompts
to install it).

**Track generates the `.gitignore`, then the user owns it.** Two presets: **Edits**
(everything ignored except `<plugin>.ledger/**` — the default for downloaded mods) and
**Everything** (authoring: assets tracked; plugin binaries ignored in both modes, they
are compiled artifacts). mEdit never rewrites the file; in-between wishes are a hand
edit, which is exactly the fluency manual tracking assumes.

**The DB becomes an index over documents.** One `records` documents table
(plugin, form_key, type, ref, identity columns, JSON document — the same bytes as the
ledger file) replaces the reflected per-type wide tables and all five vmad/condition
side tables. Index tables survive unchanged in kind (`form_lookup`,
`form_references`, `placement`, `cell_location`, `plugins`), extracted from documents
at ingest. User filter SQL survives verbatim through generated `json_extract` views
emitted by the same reflector that used to emit DDL; hot fields get promoted to real
extracted columns only if measurement demands it. The 2026-08-19 query audit found
exactly one field-predicate consumer (user filter SQL) and five union-over-all-tables
query shapes that collapse to single queries.

## Execution

**Gut and rebuild — no cohabitation.** Old and new machinery never run side by side; no
compatibility shims; the stage-1 hidden ledgers under `%LOCALAPPDATA%/mEdit/ledgers/`
are abandoned, not migrated. One inside-out greenfield arc: codec (JSON kernel) →
documents DB + views → repo layer (Track) → text edit path + Save & Compile → bridge
watcher + dialog → extension wiring → demolition sweep. The tree may be red mid-arc;
the suite is green again before the arc closes.

**Gates before "accepted" hardens into "built":**

- Filter probe: representative user filters over a full FO4 load order complete in low
  single-digit seconds against the generated views, else the promoted-column fallback
  engages (measured, not assumed).
- The round-trip stability gate (#369) stays in the suite permanently; Mutagen stays
  pinned until the 0.54 ObjectTemplate regression (#385) is resolved upstream.
- `.bak` (ADR-0008) retires only after compile-from-text has soaked.

## Consequences

1. **Deleted**: all pending-change machinery (service, graph, resolver, tables, tree,
   prompts, wire surface), the aggregate SCM provider and its spec, vendor-on-first-touch
   triggers, drift classification / provenance payloads / upstream anchors (#388) /
   automatic rebase (#382), the lifecycle reconciler (#392) and stale-gitdir sweep
   (#399) — both existed to reconcile hidden external gitdirs that no longer exist —
   the wide per-type tables, the five nested side tables and their indexers.
2. **Kept**: the per-record codec (#367, swapped to the JSON kernel) with shallow
   container stripping; the round-trip gate (#369); the journal in reduced form
   (multi-plugin compile atomicity); timestamped `.bak`; crash-repair-from-ledger
   (#381, re-scoped to compile-from-text); `GitCli` (thinnest layer over the git the
   native UI requires anyway); the reflector (retargeted from DDL to view generation
   and editor field metadata).
3. **Deferred, compatible by construction**: agent/script runs as branches with
   merge = acceptance — branching is now the core editing idiom, so the agent milestone
   shrinks to "another branch." Save & Compile serializing only the working tree is the
   one obligation the deferral imposes, and it holds for its own reasons. Asset-history
   management (LFS) waits for a real need; asset divergence remains Mod Management's
   Anchor concern.
4. **Accepted costs**: mod updates are manual git work (rebase/merge run by the user,
   structured by the topology); mega-plugin repos are heavy (~100k files / ~100 MB at
   track and at update — hardlink deployment skips them; during the MO2-launch alpha a
   tracked mega-mod's text tree is swept into USVFS, an alpha-only caveat); publishing
   a mod folder as an archive ships its `.git` unless the user excludes it; asset
   tracking under the Everything preset bloats history (LFS deliberately not designed
   now); ad-hoc SQL over arbitrary fields runs through `json_extract` views instead of
   native columns.
5. **Boundary simplification**: no provenance payload crosses contexts — the
   2026-08-19 boundary amendment of ADR-0040 is retired along with the rest of it. The
   boundary object returns to origin + physical plugin path (ADR-0036 unchanged). Mod
   Management still never touches git or the backend; the backend still learns
   everything by observation.

## Supersessions

- **ADR-0040 and both amendments: superseded in full.** Stages, truth partition,
  vendor-on-touch, provenance payloads, hidden gitdirs, aggregate provider, commit =
  save. What survives (codec, shallow strip, one-record-one-file, journal, gates) is
  restated here on new terms.
- **ADR-0002 (plugins as source of truth): amended.** For a tracked mod, per-record
  text is the working source and the binary is the compiled artifact; the binary
  remains the interchange truth with every external tool, flowing back through the
  bridge. For untracked mods ADR-0002 stands untouched.
- **ADR-0017 / 0028 (pending model, change groups): superseded in full** as user-facing
  concepts and as storage. Closure *computation* survives only as compile-internal
  masters/renumber derivation.
- **ADR-0029 (Pending Changes tree): superseded** — the surface retires with the model.
- **ADR-0025: stays dead** (was already superseded); the ref dimension that replaced it
  is itself replaced by the documents table.
- **ADR-0008 (timestamped backups): retained** until compile-from-text soaks.
- **ADR-0020 (stage-time validation): kept, relocated** — checks become diagnostics
  against text; the acceptance-time re-run belongs to the deferred branch-merge
  milestone.
- **ADR-0034 exception stands**: tracking/compile/branch UX follows git and VS Code
  native idioms, not xEdit — xEdit has no pending-change model.
- **ADR-0036 (origin identity), ADR-0038 (derived masters), ADR-0003 (Mutagen as
  parser), ADR-0019 (unified tree), ADR-0023 (placement side tables), ADR-0031
  (FormKey lookup), ADR-0032 (generic by reflection — the codec generator and the view
  generator are now the reflection): all stand.**

## Rejected alternatives

- **Automatic tracking (vendor-on-first-touch), lazy per-record baselines** — the
  automatism was the complexity: it forced hidden repos, drift classification,
  provenance payloads, reconciliation sweeps, and the per-record truth partition.
  Manual + eager deletes them all; the one-time track cost is honest UX. Lazy
  vendoring was premature optimization inherited from the invisible-tracking premise.
- **A parallel direct-binary write path for untracked mods** (xEdit-style session
  memory + direct save) — rejected: friction on untracked editing is wanted, and a
  second write path forever is the shoehorn returning.
- **Standalone bridge process** — second deployable, second Mutagen load, IPC races,
  for no benefit over a decoupled assembly: a watcher that's down misses nothing
  because the load-time hash check must exist anyway.
- **Hidden external gitdirs (`.git` gitlink or hashed-path gitdirs)** — invisible to
  the native git UI, breaks on folder rename, needs sweeps and reconcilers. In-folder
  `.git` is more robust under the never-assume-exclusive-ownership rule, not less.
- **Registry of tracked mods / wipe detection / bundle backups** — tracked = `.git`
  exists; git itself has no registry either. MO2 destroying a repo is an
  alpha-cohabitation hazard, not a supported scenario.
- **YAML text + the DuckDB community `yaml` extension** — the extension
  (teaguesterling, MIT, active as of 2026-07, `yaml_extract` over columns) is good
  enough to keep the door open, but it is a single-maintainer community dependency in
  the hot query path with per-DuckDB-version rebuild coupling and offline packaging
  weight, bought for prettier raw files. JSON is built in; one format everywhere.
- **Spriggit-the-product as the serializer** — unchanged from the #359 spike, and
  stronger: the shallow-strip workaround for the generated serializers' container
  defects (#387) requires library-level control the CLI doesn't expose.
- **Change-group gating at commit** — git's own model is that history may hold
  non-building states; the only door where plugin validity is at stake is compile.
