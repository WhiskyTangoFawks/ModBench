---
status: accepted
---

# Tracking is manual, the repo lives in the mod folder, and save compiles from text

> **Amendment (2026-08-21, #437):** the term **ledger** is renamed to **source** — the
> per-record text tree is the plugin's source and the binary its compiled artifact; a
> ledger's append-only/transactional connotations never fit. Code, disk suffix
> (`<plugin>.source/`), wire surface, and living docs are renamed; this ADR keeps its
> original vocabulary as a historical record — read every "ledger" below as "source".

> **Amendment (2026-08-21, #444):** the source tree's inner layout, the shallow-strip
> containment posture, the DB-seeded-from-binary ingest for tracked mods, and the
> whole-mod-API prohibition are all superseded by the final amendment section below
> ("Source is complete…"). The flat `<type>/<formkey>.json` layout described in this
> ADR's body never shipped in that form.

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

#### Provenance mechanics, refusal posture, and uniform Track *(amendment, 2026-08-19)*

Settled in the same-day design follow-up (review conversation on the rebuilt milestone;
walked through the full external-action space against MO2's actual `meta.ini` behavior).

**Save & Compile commits — to a parked ref, never to the branch.** Each compile snapshots
the compiled working tree as a real commit object (the `git stash create` mechanism:
no HEAD, branch, or index movement) at **`refs/medit/last-compile/<plugin>`**, its message
carrying a `Binary-SHA256` trailer for the binary it produced. This is the reference for
"the binary as Modbench last wrote it": external-change detection and crash repair (#381)
compare the on-disk binary against one ref read; the watcher uses it to ignore Modbench's
own writes. The ref advances only after the binary write lands (inside the journal's
recovery unit), is untouched by every porcelain gesture the user can make (rebase, amend,
squash), preserves the exact source tree each binary came from, keeps a free audit trail
in its reflog, and lets superseded snapshots fall to gc. A missing or orphaned ref
degrades to asking the user, never to guessing. Track initializes the ref to the pristine
snapshot so detection is uniform from the first moment. Commit-to-the-branch (auto-commit
per save, or compile refusing a dirty tree) was considered and rejected: it resurrects
the superseded commit=save, spams history or forces a commit per tweak-test iteration,
and multiplies rebase conflicts across machine commits.

**`meta.ini` is a source, never tracked content.** Baseline trailers become
`Upstream-Version`, `Binary-SHA256`, `Meta-SHA256` — all optional (authored and
manually-installed mods may lack a meta), read from `meta.ini` as opaque bytes by the
backend at track/baseline time (observation, not a cross-context payload; the boundary
object is unchanged). The file itself is never committed: mod-manager metadata mixes
provenance with mutable workflow state — one MO2 update check rewrites `meta.ini` across
every mod (`lastNexusQuery`) — and a tracked copy would mass-dirty every repo and jam
refuse-over-dirt rebases. General rule: **never track a file that changes for non-content
reasons.** When Modbench later owns installation, its install pipeline writes the same
trailers firsthand and pre-answers the external-change dialog; the `Meta-SHA256` tell
degrades gracefully to a fallback for out-of-band changes.

**Trailers may inform defaults, never actions.** Narrowing the "never by classification
machinery" clause: machinery may read trailers to pre-select the default answer in a
dialog the user answers (external change with `Meta-SHA256` changed defaults to
"upstream update", unchanged to "your own edit") — never to act without one. The dialog's
UX is pinned explicitly on #417 and folds into the Track/Compile surface spec on ship.

**Refusal posture follows git: refuse, and the user fixes it.** An offered rebase with
any uncommitted dirt refuses with a message naming the paths — commit/stash/discard are
the user's gestures; automation may be layered on later, not now. Compile refuses states
it cannot emit without changing FormKeys (ledger paths and DB keys are FormKey-keyed; a
silent renumber would rewrite the source out from under itself) — multi-plugin renumber
scenarios are deferred to compile-time design when a real need arrives.

**Track is uniform; Authored vs Modified is workflow, not a mode.** Track always
serializes, commits pristine to `main`, and checks out the edit branch. "Authored" is the
workflow of merging into `main` at will; "Modified" is the workflow of keeping `main`
pristine. Modbench stores no mode and nothing branches on the distinction.

#### Source is complete, tracked plugins load from source, and Spriggit is the format specification *(amendment, 2026-08-21, #444)*

Decided in the #444 design pass (maintainer-grilled to closure over three rounds), on
the evidence of the #444 spike
([spike-444-folder-split-containers.md](../research/spike-444-folder-split-containers.md)):
both #387 container defects that forced the shallow-strip are artifacts of driving the
generated serializers per-record with a shared target directory — the whole-mod
folder-split path has neither, probe-confirmed on real data. "The source must contain
everything required to compile the plugin, and a tracked plugin's read model must load
from its source — never from the compiled artifact" is the principle this lands
("that's not how coding is supposed to work" was the test the prior design failed).

**1. The source tree adopts Spriggit's layout wholesale.** Inner layout of
`<plugin>.source/` (root folder and deployer rules stay #441's): the serialization
library's folder-split output exactly as Spriggit configures it — group folders,
block/sub-block directory nesting (`Cells/<b>/<sb>/…`, `Worldspaces/<ws>/<X, Y>/<X, Y>/…`),
`<EditorID> - <FormKey>.json` record names (bare FormKey when no EditorID; an EditorID
edit is a git rename with identity machine-recoverable from the suffix), root
`RecordData.json` as the **mod header's source file** — closing the header-only-in-binary
gap — and Spriggit's embed customization verbatim
(`Cell.{Temporary,Persistent,Landscape,NavigationMeshes}`, `Worldspace.TopCell` inline;
their `SortList` calls excluded only until the 1.38.x bump). Containment is the path:
a cell's place in the world is its directory, and **`ContainerAssembler`'s DB-driven
reassembly retires** — compile reads structure from the tree. The **shallow-strip
posture retires with it** (`ContainerStripFields`, the codec's `NoRecordFolders` /
`DiscardChildRecordStreams` suppressions — all existed to fight the un-customized
serializer). "One record = one file" is restated as **one source unit = one file**:
embedded child records are index rows extracted from the parent document, and there is
**one document shape everywhere** — probe-pinned byte-identical between the per-record
door and the whole-mod door once two codec-side deltas are removed (below).

> **Erratum (2026-08-21, #450 — implementation).** The sentence above is wrong about the
> two codec suppressions: `NoRecordFolders` and `DiscardChildRecordStreams` are **retained**.
> `ContainerStripFields` did retire as stated (it survives as `ContainerChildFields`, a
> child-slot table with no stripping surface), and so does the shallow-strip posture — but
> the suppressions were never part of it. Spriggit embeds five slots, not all containment:
> `Cell.{Temporary,Persistent,Landscape,NavigationMeshes}` and `Worldspace.TopCell` only.
> `Quest.{DialogBranches,DialogTopics,Scenes}` and `DialogTopic.Responses` stay folder-split
> on both doors, and the per-record codec passes `directory: string.Empty`, so without the
> suppressions one real Quest writes ~1,057 directories — one per dialogue topic — into the
> process's working directory, for every container in every indexed plugin.
>
> This costs the decision nothing: byte parity is what the retained suppressions **deliver**,
> not a compromise against it. They redirect the child *streams and folders*; the parent's own
> bytes are untouched either way. `DocumentShapeParityTests` pins that with zero
> normalization, for a populated Cell (embedded) and a populated Quest (folder-split) alike —
> check the claim there rather than taking this paragraph's word for it.

> **Erratum (2026-08-21, #454 — implementation).** `ContainerAssembler`'s retirement above
> has **landed**. Save & Compile deserializes `<plugin>.source/` whole through the same
> generated door `TrackService` (#451) and `SourceIngest` (#452) use — the third and last of
> the three point 4 names — and the class, its DB-driven reassembly and its tests are deleted.
> Containment is the path in fact, not only in principle. Reading the root `RecordData.json`
> comes free with the whole-tree read, so the compiled binary now carries the source's own mod
> header rather than a freshly minted empty one; that is the header-only-in-binary gap above,
> closed on the write side too.
>
> **One thing the retirement did not take with it, and the reason is not obvious.** The
> whole-mod reader ends every group with `RecordCache.SetTo(x => x.FormKey, records)`, so two
> source files in one group folder claiming one FormKey silently collapse to whichever was read
> last — a record the user can see in their tree and cannot find in the compiled plugin, with no
> diagnostic. That last-wins behaviour was **not** adopted. Compile's FormKey-collision refusal
> is kept, and because the answer is already gone by the time the mod exists, it is asked of the
> **tree** instead: `SourceUnitResolver.FormKeysWithMoreThanOneSourceUnit` counts source units
> per FormKey in one walk, covering same-folder and cross-folder collisions alike. The state is
> reachable without Modbench's help (another tool duplicating a file, a partially restored
> backup, an interrupted rename), which is why it is refused rather than accepted as a property
> of the reader.
>
> Also settled here, having been left in the future tense by #450's own note: compile does **not**
> restore folder-split child order and nothing should claim it does. Spriggit's layout carries
> none — the `"[N] "` file-name prefix its reader sorts on is written only under
> `Overall.EnforceRecordOrder`, which neither this project nor Spriggit enables — so a compiled
> binary's children come back in the tree's order, stable but not canonical against the pre-Track
> binary. For FO4 `DialogTopic.Responses` that is genuine semantic loss (GRUP order is the sole
> carrier of dialogue evaluation order), tracked as **#459** pending a strategy decision.

**2. Tracked plugins ingest from source.** Working tree → Effective, git `HEAD` → Head;
the binary is never consulted for a tracked plugin's content. By construction this
deletes the reconciliation-sweep class (`WorkingTreeCreateRediscovery`, the
delete-at-load reappearing-record gap) and dissolves the #369 decompile-vs-parse
structural mismatch for tracked plugins — one parse, not two. `SourceFreshness` narrows
to mid-session external moves; it no longer corrects a binary-seeded ingest. Untracked
plugins keep the binary-overlay ingest unchanged — same document shape by construction,
so the read model never sees a dialect. Measured cost (JSON, dev machine): 843 ms for
the 768 KB subset, 5.1 s cold for a 20 MB mega-plugin, before any clean-path shortcut.

**3. Spriggit is the format specification — never a code dependency.** The dependency
ladder was walked with compatibility weighted as a goal, and every code-dependency form
is structurally unavailable, not merely unwise: translation packages ship as dotnet-tool
executables (not `PackageReference`-able), their per-record `<Type>_Serialization`
classes are `internal` (and Modbench's editing middle — point writes, per-record ingest —
needs per-record access, so we run the source generator in our own assembly under every
option), their pins are exact on the Mutagen 0.54 line whose ObjectTemplate regression
(#385) our round-trip gate exists to reject, and Spriggit.Engine's headline feature is
runtime `dotnet tool install` + subprocess spawning. Spriggit's unique content above the
serialization library we already share is ~80 lines of convention — replicated, and
**bound by gates so it cannot drift**:

- **Parity gate**: serialize a fixture mod through our path and through real Spriggit
  (their engine accepts an injected entry point — runs in-process in CI), diff the
  trees against a pinned allowlist of *named* divergences. Today's allowlist:
  `SortList`, `OmitUnknownGroupData`, `OmitUnusedConditionDataFields` — all
  Serialization 1.38.x features, all expected to close at the bump.
- **Interchange gate**: stock Spriggit reconstructs a plugin from our tree and we
  compile a tree Spriggit wrote. This is the shipped guarantee today; **byte parity is
  the convergence target**, gated on #385 — which **we fix upstream ourselves if it
  stays unowned** (maintainer-accepted posture). Two further upstream reports from the
  spike: the parallel-dropoff captured-`streamPackage` race in
  `MajorRecordListParallelHelper` (until fixed, our whole-mod door pins a sequential
  dropoff) and the missing two-cells-per-sub-block layout coverage.
- **Sidecars verbatim, nothing extra**: `spriggit-meta.json` and the `SpriggitSource`
  `extraMeta` object in the root `RecordData.json` carry the real Spriggit package
  coordinates we converge toward (gate-verified; fallback if interchange proves broken
  pre-convergence: our own package name); `.spriggit` `KnownMasters` populated from the
  load order at Track. No Modbench-own sidecar — stock Spriggit deletes files it didn't
  write, and our provenance already lives in commit trailers (this ADR's own mechanism).
- **JSON only** (ADR-0041's format decision stands; JSON is first-class in Spriggit and
  auto-detected via the sidecars). YAML is a boundary conversion — an export command
  offered on demand, never a second live format: dual formats would fork the
  document-identity invariant, the single write path, and the gate matrix.
- **Import is binary-first**: a foreign Spriggit-managed folder is tracked from its
  binary (the interchange truth, ADR-0002); foreign trees are never parsed, so foreign
  serializer pins never need honoring and Engine's machinery stays unneeded.

**4. Codec scope amended; the whole-mod prohibition inverts.** The generated whole-mod
mixin becomes the **designated door for Track, ingest-from-source, and compile** —
`RecordTextCodecGeneratorSeed`'s AC2 guard re-scopes from "no caller, ever" (whose
rationale — lazy per-edit whole-mod cost and ADR-0040's redistribution story — is
superseded) to "only at the designated doors, always with a sequential dropoff." The
per-record codec survives for untracked ingest, reconstitution of typed reads, and
point writes, with two changes that make its bytes identical to the whole-mod door's
(probe-pinned as the only two deltas): it adopts the whole-mod **discriminator policy**
(top-level `MutagenObjectType` only where the group's element type is abstract and the
path is ambiguous — `record_type` is already an index column, and embedded children
keep their discriminators via the kernel's own abstract-element rule), and it drops its
self-added **trailing newline**. Canonicalization clause: bare `\n` newlines, no
trailing newline — Windows behavior of the whole-mod door verified at implementation,
the parity gate adjudicating.

**Numbers** (dev machine, JSON kernel, embed applied): whole-mod serialize 1.5 s /
3,943 files (768 KB subset, un-embedded) and 5.8 s / **19,430 files** / 135 MB for the
20 MB mega-plugin — embed cuts the mega-mod file count 85% from the un-embedded
132,787, softening consequence 4's mega-repo cost; round trips byte-stable in both
configurations.

**Interactions**: #441 keeps the root folder + deployer rules, and its inner-layout
question is answered here. #440 (container copy) re-triages against
containment-as-path. The #430/#432 delete-at-load gap is resolved by construction, not
patched. The dormant "Spriggit import/export" milestone is substantially absorbed:
matching the format *is* import/export, with YAML export as the on-demand residue.
