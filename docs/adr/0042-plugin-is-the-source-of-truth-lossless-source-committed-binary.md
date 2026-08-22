---
status: accepted
---

# The plugin is the source of truth again: the source is its lossless, gate-verified editable form

> **Amendment (2026-08-22, #473):** decision 5's format-identity stamp and its load-time
> refusal gate are retired — no version is written at Track, and nothing is compared at
> session load. Compatibility is not predicted, it's observed: compiling the source is
> the one signal, uniform regardless of why it fails. See the amendment section below
> ("Format identity is not stamped…") for the replacement; the Consequences bullet on
> Mutagen bumps and #473's original acceptance criteria are superseded by it.

Decided in the 2026-08-22 design session (grilled to closure), which began as #459's
final design pass and ended by re-grounding the whole Spriggit relationship. Supersedes
ADR-0040's Spriggit-codec decision and ADR-0041's #444 amendment ("Spriggit as format
specification"); restores [ADR-0002](0002-plugins-as-source-of-truth.md) unamended.
*(File name kept from the first draft, which also committed the binary and gated commit
on compile — both withdrawn the same day; see "Withdrawn the same day" below.)*

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
   files + oracle + allowlist) took ownership of something someone else understands
   better than we do, while carrying a very heavy load: anything upstream changes
   outside the configuration — library behaviour, entry-point glue — would break a
   persisted artifact silently.
3. **Persisted artifacts make the serializer version matter**, and we had no answer
   for an existing tree after a Mutagen bump beyond re-running a tool we don't control.

The resolving insight: we don't have access to the real truth the way software does —
we decompile. So make the decompilation **provably faithful**, and the plugin stays the
truth.

## Decision

**1. The plugin is the source of truth — one plugin, at the mod folder root.** It is
what the game loads, what the mod manager deploys, and what every other tool edits.
There is no second, hidden, Modbench-owned copy and the plugin is not committed to the
mod's repository: `refs/medit/last-compile/<plugin>` (ADR-0041) remains the reference
for "the binary as Modbench last wrote it", and the existing load-time hash check and
bridge watcher remain how external change is observed.

**2. The source is Modbench's own format, and it is lossless.** Spriggit's layout is
no longer a specification we are held to. The one rule, and the test that proves it:
**`compile(serialize(plugin))` is byte-identical to `plugin`** (the existing
`CompileRoundTripGateTests`, with no allowlist). Per-record model equality is the
diagnostic that names the broken record when byte identity fails. The gate runs in
tests **and at Track, over every record of the plugin being tracked** — a plugin that
does not round-trip is refused, with the failing record named.

**3. Nothing is omitted and nothing is re-sorted in the files — ever.** Byte identity
of the files is the safety net, and every omission, however well proven, is a hole in
it. Omission and sorting are *view-layer* concerns: if header counters, timestamps, or
Creation-Kit-shuffled lists make a diff noisy, the diff view or the editor hides or
sorts them at render time, and the files underneath stay a faithful image of the
plugin.

**4. Order is carried in the tree.** Every folder-split list (`DialogTopic.Responses`,
`Quest.{DialogTopics,DialogBranches,Scenes}`, Cell/Worldspace children) is written with
the serialization library's existing `[N] ` filename numbering, which its reader already
honors. The directory listing tells the truth; the cost is rename churn on mid-list
inserts, rare for dialogue. #459 is thereby a definition of our format, not a bug to
wait on. The Cell/Worldspace *embeds* (children inline in the parent document) are kept
on our own grounds — one document per cell is the tree a human wants — and
`SourceUnitResolver` already addresses embedded children.

**5. Format identity lives in the root document** — the Mutagen package version and a
layout version. A tracked mod whose identity does not match the running codec is
**refused with a re-Track instruction**; re-Track from the root plugin (working tip) or
from the mod's origin archive (pristine `main`) is the migration action. A
format-breaking bump with edits in flight on a downloaded mod is the one awkward case:
re-Track, then rebase the edit branch. Pre-alpha, documented, manageable — not worth
machinery.

**6. Spriggit has no role in v1.** No stamp, no `.spriggit` sidecar, no parity oracle,
no allowlist, no import of Spriggit-shaped trees. Interop, when wanted, is *export*: run
the real Spriggit tool on the plugin. Upstream bug reports are filed as good
citizenship, off our critical path, and **every text posted to another project is
signed off by the maintainer before it is posted** (#385 → Mutagen-Modding/Mutagen#684,
2026-08-22).

## Withdrawn the same day

The first draft of this ADR also **committed the plugin binary beside the source at
every commit** and, to keep that pair honest, **gated commit on compile** via a
pre-commit hook. Both withdrawn within hours, on the maintainer's re-examination:

- A committed binary's only benefit once the text is lossless is a safety net against
  *our own codec bugs* and a convenience for format-breaking bumps. The root plugin
  already is the working tip's binary; the origin archive already is pristine `main`'s.
  The residual edge case is small enough to be a documented migration (decision 5).
- A second plugin copy — committed or hidden — confuses the UX ("which one is real?")
  and either duplicates `refs/medit/last-compile`'s role or makes git see every external
  tool's edit as binary dirt that the commit hook must then defer on.
- With no committed pair to keep honest, the commit hook degrades to "auto Save &
  Compile on commit", reversing ADR-0041's ungated commit for no remaining invariant.
  **Commit stays ungated; Save & Compile stays explicit**; the compile-pending
  decoration (#449) stays meaningful.

Recorded so nobody re-proposes either without the reason it was dropped.

## Consequences

- **The git-native investment survives intact.** Measured 2026-08-22: the read/query
  side (`DuckDbRecordIndex` 2,090 lines, `json_extract` views, typed reads,
  diagnostics) is already "index built from serialized documents" and is untouched;
  the write path's file-addressing layer (`SourceUnitResolver`, `SourceIngest`,
  `SourceRecordPath`, the rename/path halves of `RecordEditService` and
  `PluginCompileService`, ~1,750 lines) is kept because text remains input. The
  alternative "text is a read-only view" design would have deleted it and left `AtRef`
  (compile a named ref — how pristine restore works) without a mechanism.
- **What is removed**: the three Spriggit customization replicas, `SpriggitSource`/
  `.spriggit` sidecars, `SpriggitParityGateTests` and its allowlist, and every "read at
  implementation from `references/spriggit`" rationale (~600 test lines). #455's oracle
  install is no longer a gate. The two-door document-shape parity test stays — it checks
  our own two serializers agree.
- **Git rebase/merge of text, scripts, agents and hand edits all remain first-class**
  — the text is verified lossless, so merging it is merging records. The upstream-update
  rebase story in ADR-0041 stands.
- **Diffs show what actually changed in the binary**, including header counters and
  timestamps when a plugin last touched by the Creation Kit is tracked. That is true,
  not noise; hiding it is the diff view's job (decision 3). mEdit's own writes do not
  churn.
- **Mutagen bumps** are a format-identity change (decision 5): refuse-and-re-Track. The
  #385 pin gates nothing but itself.
- **Existing tracked trees need re-Tracking** — same alpha posture ADR-0041 took for
  #451 and #455's format changes.
- **Decision 2's gate is live at Track, and its cost is measured, not assumed** (#471).
  Track now recompiles the tree it just wrote for each plugin, in a scratch directory,
  before committing anything, and refuses (naming the first record whose Mutagen-generated
  deep equality fails, or the header/container structure if every record matched) unless
  the result is byte-identical to the plugin's own original bytes. Measured 2026-08-22 on
  the committed 768 KB / 3,940-record fixture (`CutDownPluginFixture` — the same subset
  ADR-0041's own "843 ms... 768 KB subset" figure used), steady-state over three runs: Track
  without the gate ~1.7 s, Track with the gate ~2.3-2.5 s — roughly +40% for one extra
  deserialize and one extra binary write per plugin, paid once regardless of record count
  (per-record model equality is reached only when the gate has already failed). **The
  ~20 MB "mega-plugin" figure this ADR's own Context section quotes (5.1 s cold,
  ADR-0041) has no equivalent fixture to re-measure against in this environment**: no
  committed or locally-available mod plugin near that size exists (the largest real mod
  plugin found across a 204 GB curated Fallout 4 install is 246 KB); the real Fallout 4
  DLC masters present locally (8-330 MB) are official base-game content, not a mod-shaped
  fixture, and re-purposing one would need a full-data-folder session-load harness outside
  this ticket's scope. Disclosed rather than extrapolated to avoid reporting a fabricated
  number — same posture #459 and #470 took for their own real-install gaps.

## Supersessions

- **ADR-0002: restored unamended.** The plugin is the source of truth for tracked and
  untracked mods alike; for tracked mods the lossless source is the editable form of
  the same truth, verified by the gate.
- **ADR-0040's "codec from Spriggit" decision and ADR-0041's #444 amendment: superseded**
  — Spriggit as format specification, the replica customizations, the parity oracle, the
  stamp, binary-first import of foreign trees. The #444 amendment's *other* content
  (source is complete, header in source, containment as path, ingest-from-source,
  whole-mod door) **stands**.
- **Everything else in ADR-0041 stands**, including the ungated commit: manual Track,
  repo in the mod folder, pristine `main` + edit branch, native git UI, the bridge,
  compile-as-compiler, `refs/medit/last-compile`.
- **ADR-0003 (Mutagen as parser), ADR-0032 (generic by reflection), ADR-0038 (derived
  masters): stand.**

## Rejected alternatives

- **A — keep Spriggit's format as the system of record, harden it** (stamp as an exact
  `(Spriggit, Serialization, Mutagen)` tuple; upstream-only fixes; extract Spriggit's
  customizations from the published package as a data manifest and generate ours from
  it; format-upgrade gesture running the stamped Spriggit tool out-of-process). Workable,
  and the manifest idea is sound for the *configuration* layer — but library behaviour
  and Spriggit's ~60-line entry-point glue sit outside any manifest, so the design still
  relies on upstream not changing things we can't see; and it keeps a deliberately lossy
  format as truth. The first honest stamp would also have waited on #385 + net10 +
  Mutagen 0.54.
- **B — binary is truth, text is a regenerated read-only view, edits go straight to
  the Mutagen model.** Version-independent, but discards the file-addressing write path
  (~1,750 lines + ~1,150 test lines), needs a new mechanism for pristine restore, and
  loses git-native merge/rebase of content (binaries conflict on every rebase). A
  *verified* lossless text is trustworthy input, which gets the safety without the loss.
- **Committed binary + commit-compiles hook** — see "Withdrawn the same day".
- **Fork Spriggit / ask for a library / per-record API upstream.** Three mismatches
  (tool packaging, net10, exact 0.54 pins) plus `internal` generated serializers; even
  granted, it binds us to their version exactly, and #385 shows why that is not ours to
  accept on their schedule.
- **Option D on #459 (local post-write `[N] ` prefix on `Responses/` only, byte-identical
  to a hoped-for upstream fix)** — rejected by the maintainer as a divergence from a
  format we claimed to be held to. Moot now: numbering every folder-split list is our
  format's definition (decision 4).

#### Format identity is not stamped; compile failure is the uniform signal *(amendment, 2026-08-22, #473)*

Decided the same day, on review of decision 5 before #473's implementation started: a
version comparison was the wrong trigger, and turns out not to need a stamp once retired.

**The trigger was wrong.** A stored identity mismatch is a *guess* that the source won't
compile, and a bad one both ways: comparing it against the running codec refuses mods
that would round-trip fine (a Mutagen bump for reasons like #385 has nothing to do with
whether our own JSON shape changed), and it says nothing when hand-edited or
externally-corrupted source breaks compile without any version ever moving. The real
signal is compiling itself succeeding or failing — and once that's the signal, *why* it
failed stops mattering: a version-driven format break and a user's bad hand edit produce
the same event and the same remedy (re-Track to regenerate the source). Decision 5's
load-time refusal is retired; a tracked mod opens regardless of what, if anything, its
source claims to be. Detection moves to the existing compile path — Save & Compile,
already explicit per this ADR — and reuses the named-failure diagnostic decision 2's
round-trip gate already produces (the failing record, or the header/container structure
if every record matched); there is no separate mismatch-specific message.

**The stamp itself does not survive.** Walking through every way a version number could
still be load-bearing once it no longer gates anything:

- A non-breaking codec change (additive field, internal refactor) needs nothing — the
  deserializer just defaults the new field, unconditionally, for every tree whether old
  or new.
- A breaking change where old and new shapes differ in their content (a renamed key, a
  field's presence or absence) migrates by sniffing the data itself — no stored version
  is needed to decide which reading applies.
- A breaking change with no possible migration fails compile with the round-trip gate's
  own named-failure diagnostic; a version number would not change the remedy (re-Track)
  or add information the failure doesn't already carry.
- Hand-edited or externally-corrupted source fails compile the same way, and by
  construction has nothing to do with a version at all — proof the uniform path works
  without one.

The one case where a discriminator would actually earn its keep — two shapes that are
structurally indistinguishable from each other but mean different things across a
breaking change — is narrow enough to be handled the day it happens, scoped to the one
ambiguous field or document type that needs it, not stamped on every tracked mod from
day one against a disambiguation need that may never arrive. A root-document-wide
version field is exactly the kind of speculative infrastructure the load-time gate
already was. **No format-identity field is written at Track.**

**What decision 5 becomes:** codec changes are expected to stay backward-compatible
(default new fields, sniff old shapes for a migration) wherever feasible — the standing
obligation this amendment adds, stated by the maintainer directly ("we have control here,
and should be able to avoid making breaking changes"). When a break is genuinely
unavoidable and cannot migrate, compiling the affected old source fails, and the user
sees one message naming the failure and pointing at re-Track — the same message
hand-edited or externally-corrupted source already produces through the same path. That
uniform failure path is #473's remaining scope.
