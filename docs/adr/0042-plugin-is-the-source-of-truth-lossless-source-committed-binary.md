---
status: accepted
---

# The plugin is the source of truth again: lossless own-format source, committed binary, commit compiles

Decided in the 2026-08-22 design session (grilled to closure, four clusters, every
question answered), which began as #459's final design pass and ended by re-grounding
the whole Spriggit relationship. Supersedes ADR-0040's Spriggit-codec decision and
ADR-0041's #444 amendment ("Spriggit as format specification"); reverses ADR-0041's
ungated commit; restores [ADR-0002](0002-plugins-as-source-of-truth.md) unamended.

## Context

ADR-0041's #444 amendment made Spriggit's text format our **system of record**: the
source tree adopted Spriggit's layout and customizations file for file, a parity oracle
held us to it, and the binary became a compiled artifact. Three facts surfaced while
finishing #459 under that model:

1. **The format is lossy on purpose.** Spriggit's own docs (`docs/omissions.md`,
   `docs/sorting.md`) state that omitted fields come back as *defaults* on deserialize
   and that Creation-Kit-shuffled lists are re-sorted. The maintainer's goal is clean
   git diffs, not round-trip fidelity. A format that loses on purpose cannot be tested
   for losing by accident — the intentional loss masks the accidental kind. #459 (INFO
   order destroyed by the folder split; behavioural loss in FO4, general across games
   per #464) is exactly such an accident, invisible to Spriggit's own set-and-count
   correctness gate.
2. **Spriggit is not consumable as a library, and our pin sits in a gap it never
   occupied.** `Spriggit.Json.<Game>` is a `PackAsTool` exe (net10 from 0.41) with
   exact pins `[Mutagen 0.54.0]` / `[Serialization 1.38.6]`; its generated per-record
   serializers are `internal`. Every published version from 0.30.0 to 0.42.0-alpha.2
   was inspected: **none ever pinned Mutagen 0.53.x** — the line jumps from 0.52-alpha
   to 0.54-alpha. Our 0.53.1 pin exists only because of #385, so no stamp we write
   could be honest until #385 is fixed upstream. The replica layer (three customization
   files + oracle + allowlist) therefore takes ownership of something someone else
   understands better than we do, while carrying a very heavy load: *anything upstream
   changes outside the configuration — library behaviour, entry-point glue — breaks a
   persisted artifact silently.*
3. **Persisted artifacts make the serializer version matter**, and we had no answer
   for an existing tree after a Mutagen bump beyond re-running a tool we don't control.

The insight that resolved it: **we don't have access to the real truth the way software
does — we decompile.** The binary is the one artifact whose meaning depends on nobody's
version. Commit it.

## Decision

**1. The plugin binary is the source of truth, and it is committed.** Every commit in a
tracked mod's repository holds the plugin binary *and* its source text, in lockstep.
The committed plugin is the safety net and the version-independent meaning: any codec,
at any version, can regenerate the text from it. `.gitignore` presets change
accordingly — Edits = `<plugin>.source/**` plus the plugin binaries; Everything = all
assets plus binaries. Nothing needed to rebuild the pair is ever ignored. No LFS in v1
(the committed fixture has 22 compressed records in 3,941; measure a 2–5 MB scripted
patch output before deciding otherwise).

**2. The source is our own format, and it is lossless.** Spriggit's layout is no
longer a specification we are held to. The one rule, and the test that proves it:
**`compile(serialize(plugin))` is byte-identical to `plugin`** (the existing
`CompileRoundTripGateTests`, minus any allowlist). Model equality per record is the
diagnostic that names the broken record when byte identity fails. The gate runs in
tests **and at Track, over every record of the plugin being tracked** — a plugin that
does not round-trip is refused, with the failing record named. A field may be omitted
from the text **if and only if the gate stays green without it** — omission is proved
derived, never judged junk. No list is ever re-sorted.

**3. Commit compiles.** A pre-commit hook compiles the working tree, stages the binary,
and fails the commit if compile refuses. This reverses ADR-0041's "commit is ungated":
the invariant "text and binary agree at every commit" is the property the committed
plugin exists for, and a binary lagging its text breaks it silently. The cost is near
zero — under the compiler model compile refuses almost nothing (masters and renumber
cascades are derived, not refused). Compile also *normalizes* the source where the
gate's omission rule leaves nothing to normalize — the committed pair is always
`(binary, serialize(binary))`.

**4. Order is carried in the tree.** Every folder-split list (`DialogTopic.Responses`,
`Quest.{DialogTopics,DialogBranches,Scenes}`, Cell/Worldspace children) is written with
the serialization library's existing `[N] ` filename numbering, which its reader already
honors. The directory listing tells the truth; the cost is rename churn on mid-list
inserts, rare for dialogue. #459 is thereby a definition of our format, not a bug to
wait on. The Cell/Worldspace *embeds* (children inline in the parent document) are kept
on our own grounds — one document per cell is the tree a human wants — and
`SourceUnitResolver` already addresses embedded children.

**5. Format identity lives in the root document**: the Mutagen package version and a
layout version. On mismatch, Modbench regenerates both tips' text from their committed
plugins and commits the result — the entire version-bump story, now a mechanical step
with no old tool, no runtime matching, no escape hatch.

**6. Spriggit has no role in v1.** No stamp, no `.spriggit` sidecar, no parity oracle,
no allowlist, no import of Spriggit-shaped trees. Interop, when wanted, is *export*: run
the real Spriggit tool on the committed plugin. Upstream bug reports (#385 to Mutagen;
#464's ordering data to Spriggit) are filed as good citizenship, off our critical path,
and **every text posted to another project is signed off by the maintainer before it is
posted.**

## Consequences

- **The git-native investment survives intact.** Measured 2026-08-22: the read/query
  side (`DuckDbRecordIndex` 2,090 lines, `json_extract` views, typed reads,
  diagnostics) is already "index built from serialized documents" and is untouched;
  the write path's file-addressing layer (`SourceUnitResolver`, `SourceIngest`,
  `SourceRecordPath`, the rename/path halves of `RecordEditService` and
  `PluginCompileService`, ~1,750 lines) is **kept as-is** because text remains input.
  The alternative "text is a read-only view" design would have deleted it and left
  `AtRef` (compile a named ref — how pristine restore works) without a mechanism.
- **What is removed**: the three Spriggit customization replicas, `SpriggitSource`/
  `.spriggit` sidecars, `SpriggitParityGateTests` and its allowlist, the two-door
  document-shape parity machinery, and every "read at implementation from
  `references/spriggit`" rationale (~600 test lines). #455's oracle install is no
  longer a gate.
- **Git rebase/merge of text, scripts, agents and hand edits all remain first-class**
  — the text is verified lossless, so merging it is merging records. The upstream-update
  rebase story in ADR-0041 stands.
- **Diffs show what actually changed in the binary**, including header counters and
  timestamps when a plugin last touched by the Creation Kit is tracked. That is true,
  not noise; if it ever bothers anyone the place to hide it is the diff view, never the
  format. mEdit's own writes do not churn.
- **Mutagen bumps become cheap** (decision 5), so the #385 pin stops gating anything
  but itself.
- **Existing tracked trees need re-Tracking** — same alpha posture ADR-0041 took for
  #451 and #455's format changes.

## Supersessions

- **ADR-0002: restored unamended.** The plugin is the source of truth for tracked and
  untracked mods alike; for tracked mods the lossless source is the editable form of
  the same truth, verified by the gate and backed by the committed plugin.
- **ADR-0040's "codec from Spriggit" decision and ADR-0041's #444 amendment: superseded**
  — Spriggit as format specification, the replica customizations, the parity oracle, the
  stamp, binary-first import of foreign trees. The #444 amendment's *other* content
  (source is complete, header in source, containment as path, ingest-from-source,
  whole-mod door) **stands**.
- **ADR-0041's ungated commit: reversed** (decision 3). Everything else in ADR-0041
  stands: manual Track, repo in the mod folder, pristine `main` + edit branch, native
  git UI, the bridge, compile-as-compiler.
- **ADR-0003 (Mutagen as parser), ADR-0032 (generic by reflection), ADR-0038 (derived
  masters): stand.**

## Rejected alternatives

- **A — keep Spriggit's format as the system of record, harden it** (stamp as an exact
  `(Spriggit, Serialization, Mutagen)` tuple; upstream-only fixes; extract Spriggit's
  customizations from the published package as a data manifest and generate ours from
  it; format-upgrade gesture running the stamped Spriggit tool out-of-process for any
  tip not at last-compile). Workable, and the manifest idea is sound for the
  *configuration* layer — but library behaviour and Spriggit's ~60-line entry-point
  glue sit outside any manifest, so the design still relies on upstream not changing
  things we can't see; and it keeps a deliberately lossy format as truth. The first
  honest stamp would also have waited on #385 + net10 + Mutagen 0.54.
- **B — binary is truth, text is a regenerated read-only view, edits go straight to
  the Mutagen model.** Gets version-independence but discards the file-addressing write
  path (~1,750 lines + ~1,150 test lines), needs a new mechanism for pristine restore,
  and loses git-native merge/rebase of content (binaries conflict on every rebase) —
  forcing a record-level replay design for upstream updates. Design C (this ADR) gets
  B's safety net while keeping A's workflow, because a *verified* lossless text is
  trustworthy input.
- **Fork Spriggit / ask for a library / per-record API upstream.** Three mismatches
  (tool packaging, net10, exact 0.54 pins) plus `internal` generated serializers; even
  granted, it binds us to their version exactly, and #385 shows why that is not ours to
  accept on their schedule.
- **Option D on #459 (local post-write `[N] ` prefix on `Responses/` only, byte-identical
  to a hoped-for upstream fix)** — rejected by the maintainer as a divergence from a
  format we claimed to be held to. Moot now: numbering every folder-split list is our
  format's definition (decision 4), not a bridge.
