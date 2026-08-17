---
status: proposed
---

# Pending changes move to git: text ledger, commit = save, merge = acceptance

Drafted from spike #359's findings
([spike-359-git-native-pending-changes.md](../research/spike-359-git-native-pending-changes.md));
proposed, not accepted — the spike's go-in-stages recommendation awaits the maintainer's verdict.

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

Vocabulary is git's own, inventing nothing (glossary draft in the findings doc §Q8):
working tree, stage, commit, branch, merge, revert, conflict. Surviving domain terms:
change-group closure, apply-to-binary, vendor.

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
   with stage 2.
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
