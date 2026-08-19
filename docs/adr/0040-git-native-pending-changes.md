---
status: superseded by ADR-0041
---

# Pending changes move to git: text ledger, commit = save, merge = acceptance

> **Superseded in full by [ADR-0041](0041-manual-git-tracking-compile-from-text.md)
> (2026-08-19), including both amendments below.** The git-native direction survives;
> the shape does not: tracking became a manual per-mod gesture (repo in the mod folder,
> eager full serialization, pristine `main` + edit branch), the truth partition,
> vendor-on-first-touch, provenance payloads, drift classification, change-group
> gating, and the aggregate SCM provider were all retired, and commit = save was
> un-fused into commit (git's own, ungated) and Save & Compile. See ADR-0041 for what
> was kept (codec, shallow strip, journal, gates) and why.

Drafted from spike #359's findings
([spike-359-git-native-pending-changes.md](../research/spike-359-git-native-pending-changes.md));
accepted with the go-in-stages recommendation. The migration epic is milestone
"5 — Git-native pending changes".

## Context

Pending changes today live in an in-memory/DuckDB buffer that dies with the session:
review happens in a bespoke Pending Changes surface; durable history, blame, and
rollback don't exist; agent-proposed edits have no multi-round review loop. The #292
design discussion produced a git-native architecture — per-mod repos with hidden
gitdirs, Spriggit-format per-record text as the ledger, the user's own edits as
working-tree changes with **commit = save**, agent/script edits on never-checked-out
branches with **merge = acceptance**, the on-disk binary only ever reflecting `main` so
the game structurally never loads unreviewed changes. Spike #359 prototyped every risky
assumption; all held (measurements in the findings doc). The one serious discovery — a
Mutagen 0.54.0 binary round-trip regression — is upstream and version-specific, not
architectural.

## Decision

Adopt the git-native architecture in three stages:

1. **Text mirror first** (shared first step of every end state): per-record text
   (via `Mutagen.Bethesda.Serialization`, library-level, vendored copy-on-write
   baselines) committed into hidden per-mod repos on every save; aggregate SCM provider
   on the native Source Control panel, read-only; raw text diff for review. The pending
   buffer is untouched.
2. **Branches**: agent/script runs become branches; merge = acceptance with change-group
   closure check and post-merge revalidation; the read model gains a ref dimension
   (committed + dirt + open branches); compare grid gains review mode
   (committed-vs-proposed columns), reached from SCM resource clicks.
3. **Retire the bespoke machinery**: `DuckDbPendingChangeService` and the pending
   tables, the drift/reconciliation lineage, unsaved-work prompts, the Pending Changes
   tree; wire protocol reworked to branch/commit/merge operations.

Gates before stage 1: Mutagen stays pinned 0.53.x until the 0.54 ObjectTemplate
regression is fixed upstream (and reported); a binary round-trip stability test joins
the suite immediately (it protects the *current* save path too); build toolchain bumps
to an SDK with Roslyn ≥ 4.14.

#### Toolchain gate: compiler pin substituted for an SDK bump *(amendment, 2026-08-17)*

#367 (the stage-1 codec) took a narrower toolchain change than this ADR specifies. The
generator needs Roslyn ≥ 4.14; the repo's SDK does not ship it, and the obvious fix — an
SDK bump — was measured against the actual build rather than assumed safe: the newer
SDK's own bundled analyzer set adds 23 `CA1873` errors across existing, unrelated files
under this repo's `TreatWarningsAsErrors`, none of them caused by the codec. A
`Microsoft.Net.Compilers.Toolset 4.14.0` package reference, scoped to
`MEditService.Core` only, satisfies the same Roslyn floor without moving the analyzer
set at all — verified: the existing solution builds 0 warnings / 0 errors with only the
compiler swapped, and the full suite's pass count is unchanged. Effect equivalent,
strictly less invasive; no `global.json`, no SDK provisioning question for other
sessions or CI. Recorded here because this ADR named the SDK specifically and the
substitution should be visible, not silent — later stages should default to the same
compiler-pin approach rather than an SDK bump unless something forces otherwise.

#### Truth partition, shallow container vendoring, upstream anchors *(amendment, 2026-08-17)*

The #387 design conversation (empirical probes plus maintainer alignment; full model and
probe evidence on that ticket) refined how this decision is articulated. Nothing here
reverses it — this is the model the decision was implicitly relying on, made explicit:

- **Truth is partitioned per record, not per plugin.** For a tracked record, ledger text
  at `main` is authoritative and the binary is a build artifact; for an untracked record
  the binary is authoritative. Tracking is monotonic (first touch vendors a baseline;
  nothing untracks). No delta is stored anywhere — every ledger file is full record
  state; "delta" exists only as git's rendering of two states. Partial coverage is git's
  own tracked/untracked distinction (the vendor-branch pattern), not an origin+delta
  scheme. The DB is a materialized read model over {binary, text@refs} — never
  authoritative, always rebuildable. Single write path: working-tree text → commit →
  apply-to-binary; the binary is only ever written from accepted text state (modbench's
  own saves) or by external tools (which is drift, below).
- **Container-shaped records vendor shallow.** Probed on #387: under `.FilePerRecord()`
  the generated per-record serializers write child major records as sibling folder trees
  keyed by *field name only* — two Cells serialized into one directory silently merge
  and cross-contaminate their children on read — and `Worldspace_Serialization` drops
  `SubCells` entirely (only the whole-mod entry point serializes worldspace blocks).
  The ledger therefore strips child-major fields before serializing a container record
  (children are their own ledger entries; containment is encoded in the ledger path),
  which preserves one-record-one-file and sidesteps both defects. Probe-confirmed:
  shallow serialize emits exactly one file, and deserialize with no child folders
  round-trips clean.
- **Upstream anchors make drift detectable and classifiable.** Baseline (vendor)
  commits carry provenance trailers assembled by Mod Management (Nexus identity,
  version, archive filename, SHA-256 of the pristine binary — opaque strings to
  Editing, same discipline as ADR-0036 origins); a sync-state hash of the binary as
  modbench last wrote it lives under the hidden gitdir, outside history. At load:
  hash unchanged → clean (O(1), no re-serialization); hash moved with provenance moved
  → upstream advance → new baselines + rebase of user commits (#382); hash moved alone
  → in-place external edit (xEdit et al.) → re-serialize the tracked set and surface
  the diff as uncommitted working-tree changes for user disposition (commit / revert /
  reclassify as upstream). Drift import refuses to overwrite uncommitted modbench edits
  on the same record — spike Q9's rule at one more door. Byte-hashing the pristine
  binary is legitimate here despite consequence 3's caveat: that caveat covers binaries
  *we rebuild*; upstream originals are stable bytes we never rewrite.

Vocabulary is git's own, inventing nothing (glossary draft in the findings doc §Q8):
working tree, stage, commit, branch, merge, revert, conflict. Surviving domain terms:
change-group closure, apply-to-binary, vendor.

#### Boundary resolution: Editing executes the ledger, Mod Management owns upstream meaning *(amendment, 2026-08-19)*

Consequence 6's sentence — "Mod Management owns repo lifecycle (vendoring, baselines,
updates); Editing sees the ref as an opaque string" — read literally, contradicts both the
standing rule that Mod Management never calls the C# backend (root CLAUDE.md) and the
shipped stage-1/2 code, where every git operation lives in Editing's `Ledger/`. The
resolution is ADR-0036's discipline applied one notch wider: split ownership of
**meaning** from execution of **mechanism**.

- **Mod Management owns the facts that give lifecycle events meaning** — what a mod is,
  its upstream identity (Nexus identity, version, archive filename, parsed from its own
  metadata in TS), the Downloaded/Authored/Modified/Adopt vocabulary. It never touches
  git, never calls the backend, and never learns the ledger exists.
- **Editing's backend executes every git operation** — repo creation, vendoring,
  baselines, commits, status, drift classification, rebase, sweeps — and treats Mod
  Management's facts as opaque strings it stamps into commit trailers and compares only
  for equality.
- **There is no cross-context lifecycle event.** Vendor, baseline, update, uninstall are
  backend *reactions to filesystem observations* at its own touch points: session load
  and plugin reread (drift classification), first staged edit (vendor), save (commit),
  startup (journal recovery, stale-gitdir sweep #399, lifecycle reconciliation #392).
  The never-assume-exclusive-ownership rule (root CLAUDE.md) forces this shape: MO2,
  xEdit, or the user can perform any lifecycle transition outside Modbench, so the
  observation-driven path must exist and be correct on its own — an event fired from
  Modbench's own UI would be a second, redundant trigger covering only a subset of
  doors. #399's triage (marker file + sweep, its option (a)) already chose this shape;
  it is the general rule, not an exception.

**The wire.** Provenance crosses as opaque data on the calls the extension host already
makes when it hands the backend a plugin file: each `ExplicitPlugin` entry of
`POST /session/load-explicit` (which already carries `origin`, ADR-0036) gains an
optional opaque `provenance` payload, and `POST /plugins/reread` carries the same. Mod
Management assembles it as pure data (`metaIni.ts`); the composition root carries it
across — never a live TS→C# call, never a callback, no new endpoint. Absence of the
payload is itself the signal "no upstream" (Authored mods, reserved origins), and such
plugins never classify as drifted (#388). Freshness equals the freshness of the
backend's knowledge of the binary itself: classification always compares a
(binary, provenance) pair observed at the same moment, and a mid-session external
update is caught at the next observation, exactly as binary drift itself is.

**Who computes what.** Mod Management: the provenance strings, nothing else. The
backend: both hashes — the pristine-binary SHA-256 stamped as a fork-point trailer at
vendor time (it is already reading those bytes for the deep parse) and the sync-state
hash whenever it writes or observes the binary — plus every classification verdict and
every git operation.

**`repo + ref`, re-articulated.** As shipped, neither the repo nor any ref ever
reaches Mod Management: the repo is keyed by the origin folder the existing boundary
object already names, and refs are Editing-internal. The boundary object that actually
crosses is **origin + provenance**, one direction, at load. Ledger-derived state
reaches Loadout surfaces (a mod's Modified badge, eventually) only as data through
composition roots joining both contexts (`PluginsTreeComposite` precedent), never
through Mod Management calling the backend.

**Where git lives, what it tracks.** Nothing in the mod folder, ever: gitdir at
`%LOCALAPPDATA%/mEdit/ledgers/<sha256(originFolder)[..16]>/gitdir`, sync-state hash
beside it outside history, cross-repo journal under `ledgers/_journal/`. The working
tree *is* the origin folder; tracked content is `<plugin>.ledger/**` per-record text
only — the binary, assets, and `meta.ini` are permanently untracked (status is
pathspec-scoped). A repo exists only once a record from that origin is vendored, so
with hundreds of installed mods the git footprint is proportional to what the user has
*edited*, not what they have installed — tracking is by touch, never by install, which
is the deliberate answer to "do we track all of them": no, and there is nothing to opt
out of. Asset files are outside the ledger entirely: an asset edit from any tool is
invisible to git; asset-level divergence is Mod Management's Anchor concern, not the
ledger's. (The working tree being the mod folder leaves room to track assets later
without relocating anything; deliberately not designed here.)

**Lifecycle through the common workflows** — each row holds through any door
(Modbench, MO2, xEdit, by hand). A = automatic/silent, C = one confirmation,
M = manual UX gesture:

| Workflow | Backend observation point | Git effect |
| --- | --- | --- |
| Install / create mod | none | nothing — no repo until first tracked edit (A) |
| First staged edit to a record | edit staged | repo created if absent, baseline commit, working-tree dirt (A) |
| Further edits, then save | save | commit = save (M gesture; the commit itself A) |
| Plugin edited externally (xEdit, CK, patcher) | next load / reread: hash moved, provenance unchanged | tracked set re-serialized; diff surfaces as uncommitted working-tree changes; disposition — commit / revert / reclassify — is the user's (M) |
| Mod updated | next load / reread: hash moved **and** provenance moved | new baselines + rebase of user commits (#382): clean replay behind one confirmation (C); conflicts go to the review surfaces (M) |
| Non-plugin resource changed | none | nothing — outside the ledger |
| Mod uninstalled / folder deleted | startup sweep (#399) | gitdir removed, loudly logged (A) |
| One plugin of a mod deleted or renamed | session-load reconciliation (#392) | ledger tree renamed onto its proven continuation, else removed (A) |

The UX consequence: the user never sees a repo and never runs git. They see the one
aggregate SCM provider (spike Q6) showing the *loaded session's* uncommitted dirt —
which is what keeps the panel bounded when hundreds of mods are tracked — plus native
diffs, and the ordinary VS Code SCM gestures land on the git-native meanings above as
the stage-3 wire rework (consequence 8) brings them online.

## Relation to existing ADRs

- **ADR-0002 (plugins as source of truth): partially inverted, knowingly.** For every
  record a repo tracks, text at `main` is authoritative and the binary is a build
  artifact; for untracked records the binary remains authoritative. Acceptance is what
  moves a record into the ledger. An Authored mod is the limiting case (full coverage).
- **ADR-0003 (Mutagen as parser): unchanged.** Reads still parse binaries; Spriggit text
  is never a load-path input.
- **ADR-0008 (timestamped backups): retained through stage 2.** `.bak` retires for
  tracked mods only when rebuild-from-text has soaked in production.
- **ADR-0017/0028 (change groups): relocated, not retired.** Closure computation stays;
  it gates commit and merge instead of the bespoke save.
- **ADR-0020 (stage-time validation): kept, plus a second run.** Stage-time for
  feedback; the same check re-runs against post-merge state at acceptance (spike Q5).
- **ADR-0025 (overlay views): superseded by the ref dimension.** The views were never
  implemented; the ref dimension replaces the mechanism they were meant to organize.
- **ADR-0034 exception stands**: pending-change UX follows git/VS Code native idioms,
  not xEdit — xEdit has no pending-change model.
- **ADR-0036 (origin identity): unchanged**, and load-bearing — the ref dimension is
  built on the same compound-key discipline.

## Consequences (dispositions of the #359 addendum list)

1. **Schema — endorsed.** Record tables gain a ref dimension (committed | dirt |
   branch); pending tables retire in stage 3. Session load re-materializes open refs
   from text (cost ∝ divergence; spike Q3).
2. **Drift machinery retired onto git — endorsed** (stage 3). A mod update is a new
   baseline commit; edit migration is a rebase. #333/#349/#356 lineage stops receiving
   investment once stage 2 lands.
3. **Binary as build artifact — endorsed** with the stage-2 gate above. #329's plugin
   deltas become Spriggit text patches derived from the mod repo; binary diffing remains
   for assets with no text form. Caveat from Q1: rebuild-from-text permutes record
   order, so rebuilds look like whole-file changes to hash-based tools — manifests must
   hash content-derived identity, not file bytes, for tracked plugins.
4. **Scripts and agents — endorsed.** A run is a branch; commits carry provenance
   (which script/agent, which inputs). Designed against branches from the start.
5. **UX — endorsed.** Exit/unsaved prompts retire (working trees persist); Pending
   Changes tree superseded by the aggregate SCM provider (per-mod providers rejected —
   spike Q6); collision rule: merges refuse over uncommitted dirt on the same record,
   git's own rule (spike Q9).
6. **Context boundary — endorsed.** Second boundary object: **repo + ref**. Mod
   Management owns repo lifecycle (vendoring, baselines, updates); Editing sees the ref
   as an opaque string (same pattern as ADR-0036's origin). CONTEXT-MAP amendment due
   with stage 2. *(Re-articulated by the 2026-08-19 boundary amendment above: as
   shipped, the crossing object is origin + provenance, Editing executes all repo
   mechanism, and repo/ref never reach Mod Management. CONTEXT-MAP amended the same
   day.)*
7. **Deployment/manifest hygiene — endorsed.** Internal gitdirs and vcs state are
   excluded from deploy and manifest hashing (#324 hazard class).
8. **Wire protocol — endorsed, stage 3.** Stage/revert/save endpoints become
   branch/commit/merge operations through the full 4-touch-point chain.

**Out of blast radius** (deliberately unchanged): DuckDB as the committed read model,
Mutagen as the parser, the conflict/winner engine, the compare grid's
versions-across-plugins core, ADR-0036's (origin, filename) identity.

## Rejected alternatives

- **Whole-mod text serialization as the vendoring mechanism** — 21 s / 132k files /
  106 MB for a 20 MB plugin (spike Q2); per-record is 160 ms.
- **Binary diff for Modified mods (Spriggit for Authored only)** — unnecessary; per-record
  state text + git's diff covers both, and the split would forfeit agentic diff
  analysis on Modified mods (spike Q10).
- **Spriggit-the-product as the integration point** — it is a versioning shell over
  `Mutagen.Bethesda.Serialization`; we integrate the library and replicate its ~10-line
  customization, avoiding its exe-per-version machinery and exact Mutagen pins.
- **Custom file extension + native diff editor as the review surface** — custom editors
  cannot participate in the diff editor (spike Q7); SCM-resource-command → compare grid
  is the route.
