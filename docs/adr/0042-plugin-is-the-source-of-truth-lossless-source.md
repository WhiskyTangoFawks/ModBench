---
status: accepted
---

# The plugin is the source of truth; the source is its lossless, gate-verified editable form

Decided 2026-08-22. Defines what a tracked mod's source *is*; the workflow around it is
[ADR-0041](0041-manual-git-tracking-compile-from-text.md). Restates
[ADR-0002](0002-plugins-as-source-of-truth.md) for tracked mods.

## Context

An earlier posture (see Alternatives rejected) made Spriggit's text format the system of
record and the binary a compiled artifact. Finishing the dialogue-order work (#459) under that
model surfaced three facts: Spriggit's format is **lossy on purpose** (omitted fields come back
as defaults, Creation-Kit-shuffled lists are re-sorted — its goal is clean diffs, not fidelity),
so a format that loses on purpose cannot be tested for losing by accident; Spriggit is not
consumable as a library and pins Mutagen versions we cannot use; and a persisted artifact makes
the serializer version matter, with no honest answer for an existing tree after a bump.

The resolving insight: we don't have access to the real truth the way software does — we
decompile. So make the decompilation **provably faithful**, and the plugin stays the truth.

## Decision

**1. The plugin is the source of truth — one plugin, at the mod folder root.** It is what the
game loads, what the mod manager deploys, and what every other tool edits. There is no second
Modbench-owned copy, and the plugin is not committed to the mod's repository:
`refs/medit/last-compile/<plugin>` (ADR-0041) is the reference for "the binary as Modbench last
wrote it", and the load-time hash check and bridge watcher are how external change is observed.

**2. The source is Modbench's own format, and it is lossless.** The one rule, and the test that
proves it: **`compile(serialize(plugin))` is byte-identical to `plugin`**
(`CompileRoundTripGateTests`, no allowlist). Per-record model equality is the diagnostic that
names the broken record when byte identity fails. The gate runs in tests **and at Track, over
every record of the plugin being tracked** — a plugin that does not round-trip is refused,
naming the record (measured cost: roughly +40% on Track, paid once per plugin).

**3. Nothing is omitted and nothing is re-sorted in the files — ever.** Byte identity of the
files is the safety net, and every omission, however well proven, is a hole in it. Omission and
sorting are *view-layer* concerns: if header counters, timestamps or Creation-Kit-shuffled lists
make a diff noisy, the diff view or the editor hides or sorts them at render time.

**4. Order is carried in the tree.** Every folder-split list (`DialogTopic.Responses`,
`Quest.{DialogTopics,DialogBranches,Scenes}`, Cell/Worldspace children) is written with the
serialization library's `[N] ` filename numbering, which its reader honors. The directory
listing tells the truth; the cost is rename churn on mid-list inserts. The Cell/Worldspace
*embeds* (children inline in the parent document) are kept on our own grounds — one document
per cell is the tree a human wants.

**5. Format identity is not stamped; compile failure is the uniform signal.** Nothing is written
at Track and nothing is compared at session load. Compatibility is observed, not predicted: a
version-driven format break, a hand edit and external corruption all produce the same event —
compile fails with the round-trip gate's named-failure diagnostic — and the same remedy,
re-Track. Codec changes stay backward-compatible wherever feasible (default a new field; sniff
an old shape for a migration); the one case a discriminator would earn its keep — two
indistinguishable shapes meaning different things — is handled the day it happens, scoped to
the one field that needs it.

**6. Spriggit has no role.** No stamp, no `.spriggit` sidecar, no parity oracle, no allowlist,
no import of Spriggit-shaped trees. Interop, when wanted, is *export*: run the real Spriggit
tool on the plugin. Upstream bug reports are filed as good citizenship, off the critical path,
and every text posted to another project is signed off by the maintainer first.

## Consequences

- The read/query side (`DuckDbRecordIndex`, `json_extract` views, typed reads, diagnostics) and
  the write path's file-addressing layer (`SourceUnitResolver`, `SourceIngest`,
  `SourceRecordPath`) survive intact — text remains input. Git rebase/merge of source, scripts,
  agents and hand edits all remain first-class: the text is verified lossless, so merging it is
  merging records.
- **Diffs show what actually changed in the binary**, including header counters and timestamps
  when a plugin last touched by the Creation Kit is tracked. That is true, not noise; hiding it
  is the diff view's job. Modbench's own writes do not churn.
- A layout or codec change that cannot migrate means re-Track — the pre-alpha posture ADR-0041
  states.
- The two-door document-shape parity test stays — it checks our own two serializers agree.

## Alternatives rejected

- **Spriggit as format specification (2026-08-21 → 2026-08-22).** The source tree adopted
  Spriggit's layout and customizations file for file, three replica customization classes plus a
  parity oracle (the real tool run as a subprocess) and a pinned allowlist of named divergences
  held us to it, a `.spriggit` sidecar and `SpriggitSource` metadata carried package coordinates,
  and a format-identity stamp in the root document gated session load. Withdrawn for the
  reasons in Context: it made a deliberately lossy format the truth, took ownership of
  something upstream understands better, and could never stamp honestly across the Mutagen pin.
- **A — keep Spriggit's format, harden it** (exact `(Spriggit, Serialization, Mutagen)` stamp,
  customizations extracted as a data manifest, format-upgrade gesture running the stamped tool).
  Library behaviour and entry-point glue sit outside any manifest; still a lossy truth.
- **B — binary is truth, text is a regenerated read-only view, edits go straight to the Mutagen
  model.** Version-independent, but discards the file-addressing write path, needs a new
  mechanism for pristine restore, and loses git-native merge/rebase of content. A *verified*
  lossless text is trustworthy input, which gets the safety without the loss.
- **Committed binary + commit-compiles hook** (this ADR's own first draft, withdrawn within
  hours). Once the text is lossless, a committed binary only guards against our own codec bugs;
  a second plugin copy confuses "which one is real?" and makes git see every external tool's
  edit as binary dirt; and with no pair to keep honest the hook degrades to auto-compile on
  commit, reversing ADR-0041's ungated commit for no remaining invariant.
- **A stored format-identity stamp with load-time refusal** (this ADR's original decision 5,
  retired the same day). A version mismatch is a *guess* that the source won't compile, wrong
  both ways: it refuses mods that round-trip fine and says nothing about a hand edit that
  doesn't. Compile itself is the signal.
- **Fork Spriggit / ask for a library / per-record API upstream.** Tool packaging, .NET target
  and exact Mutagen pins all mismatch, and it binds us to their version on their schedule.
- **A local `[N] ` prefix on `Responses/` only, byte-identical to a hoped-for upstream fix**
  (#459 option D) — moot: numbering every folder-split list is our format's definition.
