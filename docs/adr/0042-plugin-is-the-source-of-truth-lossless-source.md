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

**2. The source is Modbench's own format, and it is lossless. The round-trip verdict is model
identity, not byte identity (2026-08 amendment, #513).** A survey of 684 real, mixed-tool LitR
plugins found only 37% survive `write(parse(plugin)) == plugin` byte-for-byte — the rest diverge
on Mutagen's own encoding choices (recompressed zlib, `-0.0`→`+0.0`, subrecord/GRUP-child
reordering, derived sizes, ADR-0038's own master pruning, recomputed derived counters), never on
content. Byte identity was a test of whichever tool last wrote the file, never of our codec.

The verdict: every record in `parse(original)` has a counterpart in `parse(recompiled)` and vice
versa, and Mutagen's own generated equality mask
(`<Type>MixIn.GetEqualsMask(rhs, EqualsMaskHelper.Include.OnlyFailures)`, reached generically by
reflection — `MEditService.Core.Source.ModelIdentity.FindFirst`, shared by `TrackService`'s live
gate and the test suite's own Compile assertions, one checker and one exclusion list) reports no
failing field outside the exclusion table below. The mask, not bare `Equals`: the same survey
found bare `Equals` false-negatives on byte-identical parses across whole record families (Armor,
ArmorAddon, Race, Package, Quest, Perk, …) that the mask does not share.

**Refuses on any content difference, including Mutagen's own write-time defects** (a maintainer
decision, not a defect in this gate) — confirmed against the real LitR corpus: 16 of 684 plugins
carry a `Furniture` whose original bytes never wrote `FNAM`/`MNAM` (a CK/community-tool shape),
and Mutagen's writer unconditionally re-adds them, materializing `Furniture.Flags` from
`null` to a real derived value. That is a genuine content change, correctly refused, naming the
record type, FormKey and field (`SourceRoundTripFailedException`), until Mutagen is fixed.

*(An earlier draft of this decision cited `NPC_/QNAM` float precision drift on write as a second
example, "observed in 118 of 684 survey plugins" — that claim does not hold up: `NPC_/QNAM` is
`System.Drawing.Color`, quantized to a byte per channel at **parse** time, so any precision is
already destroyed identically on both sides of the comparison before this gate ever runs. Direct
re-verification against the full LitR corpus found zero genuine float-precision refusals; retracted
here rather than left uncorrected.)*

**Known limitation, not yet closed: the mask is not literally bit-exact for `Single` fields.**
Mutagen's generated `FillEqualsMask` compares `Single` (float32) fields with `EqualsWithin`, a
1e-9 absolute epsilon — a real tolerance band, not the "no tolerance band" this decision otherwise
states. In practice this is narrower than it sounds: one ulp of a float32 at magnitude *m* is
≈ *m* × 1.19e-7, so a 1e-9 absolute epsilon is mathematically equivalent to bit-exact for any
`|value| ≳ 0.01` — the blind spot is confined to values very close to zero. No `Double`-typed
field in `Mutagen.Bethesda.Fallout4` reaches `EqualsWithin`, so the gap does not extend there.
`ModelIdentityFloatEpsilonCharacterizationTests` pins the current (accepted, not refused) behavior
for a sub-epsilon mutation near zero, so the boundary is documented with a test rather than left
implicit. Whether to accept the epsilon as-is or bypass the mask for bit-exact numeric comparison
is its own decision, filed separately (#564) rather than resolved here.

**The one exclusion, and the only one:** derived GRUP-header fields Mutagen's own generated model
backs onto a handful of record types — populated at parse time from the enclosing group's own
header bytes, never from the record's own subrecord stream. Scoped as `(RecordType, FieldName)`
pairs, never a bare field name — `Unknown`/`Timestamp`-shaped names collide with genuine content
elsewhere on their own declaring types (`FaceFxPhonemes.Unknowns`, `PlacedObject.Unknown`,
`ConditionData.Unknown3` are ordinary subrecord data).

| Record type | Excluded fields | Backing GRUP group |
|---|---|---|
| Cell | `Timestamp`, `UnknownGroupData` | CellChildren |
| Cell | `PersistentTimestamp`, `PersistentUnknownGroupData` | CellPersistentChildren |
| Cell | `TemporaryTimestamp`, `TemporaryUnknownGroupData` | CellTemporaryChildren |
| Worldspace | `SubCellsTimestamp`, `SubCellsUnknown` | WorldChildren (the group wrapping every exterior block) |
| WorldspaceBlock | `LastModified`, `Unknown` | the individual exterior block's own GRUP, one level inside SubCells |
| WorldspaceSubBlock | `LastModified`, `Unknown` | the individual exterior sub-block's own GRUP, one level inside SubCells |
| Quest | `Timestamp`, `Unknown` | QuestChildren |
| DialogTopic | `Timestamp`, `Unknown` | TopicChildren |

The `WorldspaceBlock`/`WorldspaceSubBlock` rows were found live against the real LitR corpus while
building the survey harness below, not anticipated at plan time — proof that this table is
expected to grow exactly this way as more real plugins are checked, never by guessing a field name
in the abstract.

Everything else that changes bytes without changing content — zlib level/implementation,
negative zero, subrecord order, GRUP child order, derived sizes and counts, master pruning
(decision 4 below has its own interaction: the tree carries the original's order, a compile back
out of it emits Mutagen's own) — is **documented here, not gated**: a real plugin written by
CK/xEdit/another tool is no longer refused for encoding-only differences. Track logs which of
these an accepted plugin's first Save & Compile will lose, so nothing is silent — informational
only, deliberately not surfaced on the API response in this amendment (a categorized report is a
clean, separately-scoped follow-up if wanted).

**Byte identity stays the test for our own codec, unchanged.** `compile(serialize(plugin))` is
still asserted byte-identical to `plugin` for a Mutagen-written fixture
(`CompileRoundTripGateTests`, `BinaryRoundTripGateTests`, no allowlist) — a gap there means our
codec, not Mutagen's writer, lost something, and that stays refused exactly as before. What
changed is the verdict for a plugin that is not already Mutagen-canonical: Track's live gate, run
over every record of the plugin being tracked, and the test theories that exercise real
(CK/xEdit-authored) plugins now compare on model identity instead.

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
