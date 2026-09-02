---
status: accepted
---

# The plugin is the source of truth; the source is its lossless, gate-verified editable form

Defines what a tracked mod's source *is*; the workflow around it is
[ADR-0041](0041-manual-git-tracking-compile-from-text.md). Restates
[ADR-0002](0002-plugins-as-source-of-truth.md) for tracked mods.

## Context

An earlier posture (see Alternatives rejected) made Spriggit's text format the system of
record and the binary a compiled artifact. Working under that
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
identity, not byte identity.** A survey of 684 real, mixed-tool LitR
plugins found only 37% survive `write(parse(plugin)) == plugin` byte-for-byte — the rest diverge
on Mutagen's own encoding choices (recompressed zlib, `-0.0`→`+0.0`, subrecord/GRUP-child
reordering, derived sizes, ADR-0038's own master pruning, recomputed derived counters), never on
content. Byte identity was a test of whichever tool last wrote the file, never of our codec.

The verdict (#669 amendment, 2026-09-02 — the comparison mechanism actually in force): every
record in `parse(original)` has a counterpart in `parse(recompiled)` and vice versa, and each pair
passes a **two-stage check in one door** (`MEditService.Core.Source.ModelIdentity.FindFirst`,
shared by `TrackService`'s live gate and the test suite's own Compile assertions, one checker and
one exclusion list). Stage one is Mutagen's generated equality mask
(`<Type>MixIn.GetEqualsMask(rhs, EqualsMaskHelper.Include.OnlyFailures)`, reached generically by
reflection): a failing field outside the exclusion table below is the verdict, named precisely.
Stage two is the decider, because **the mask lies by omission and Modbench never depends on
Mutagen's generated equality being right** (upstream fixes withdrawn — Mutagen PRs #689/#690
closed, pin stays 0.53.1): a polymorphic hierarchy's derived-only fields bind through the base
overload and are silently never compared (`PackageDataInt.Data`), and a header `TransientTypes`
divergence is invisible to it entirely. A mask-equal pair is therefore compared through **the
codec itself as the oracle**: both records serialize through the same door every source file is
written through, and the documents must agree structurally — byte-equal fast path, then a
structural comparison whose only tolerances are the two model-equal respellings a binary rewrite
is entitled to (`-0`→`0` zero spelling — text-matched, no float arithmetic decides identity — and
enumeration order within a genuine dictionary field, gated on the property being a reflected
`IReadOnlyDictionary` member so an ordered list that merely looks dictionary-shaped, like
`Npc.Morphs`, never compares order-insensitively; both tolerances observed on real fixtures),
with the exclusion table's group-header-derived fields normalized out first. The
header's `TransientTypes` gets its own plain-value comparer for the same reason. Bare `Equals` is
never consulted anywhere (the survey found it false-negativing on byte-identical parses across
whole record families — Armor, ArmorAddon, Race, Package, Quest, Perk, …), and
`ComparisonDoorBoundaryTests` pins that no production code outside `ModelIdentity` reaches
`GetEqualsMask` at all.

**Refuses on any content difference, including Mutagen's own write-time defects** (a maintainer
decision, not a defect in this gate) — confirmed against the real LitR corpus: 16 of 684 plugins
carry a `Furniture` whose original bytes never wrote `FNAM`/`MNAM` (a CK/community-tool shape),
and Mutagen's writer unconditionally re-adds them, materializing `Furniture.Flags` from
`null` to a real derived value. That is a genuine content change, correctly refused, naming the
record type, FormKey and field (`SourceRoundTripFailedException`), until Mutagen is fixed.

*(`NPC_/QNAM` float precision drift is **not** a refusal source, despite appearances: `NPC_/QNAM`
is `System.Drawing.Color`, quantized to a byte per channel at **parse** time, so any precision is
already destroyed identically on both sides of the comparison before this gate ever runs. Direct
verification against the full LitR corpus found zero genuine float-precision refusals.)*

**Former known limitation, closed by #669: the mask's `Single` epsilon no longer decides
anything.** Mutagen's generated `FillEqualsMask` compares `Single` (float32) fields with
`EqualsWithin`, a 1e-9 absolute-epsilon tolerance band — but the mask is only stage one now. The
codec decider sees a sub-epsilon-but-genuinely-different float's own distinct spelling in the
documents and refuses it, so the verdict is bit-exact for numerics apart from the one deliberate
tolerance (`-0` vs `0`, a spelling a binary rewrite legitimately produces).
`ModelIdentityFloatEpsilonCharacterizationTests` pins the refusal, flipped from its
characterize-the-gap ancestor.

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

This table grows only from evidence: rows are found live against real corpora (the
`WorldspaceBlock`/`WorldspaceSubBlock` rows arrived that way), never by guessing a field name
in the abstract.

**The gate also checks a fixed allow-list of `ModHeader` (TES4) fields.**
`ModelIdentity.FindFirst`'s own per-record walk never reaches `ModHeader` — it is not an
`IMajorRecordGetter`, so `EnumerateMajorRecords()` never yields it. `TrackService.VerifyRoundTrip`
runs a second, header-only check (`ModelIdentity.FindFirstHeaderFieldDivergence`) against the same
generated equality mask, narrowed to the fields below rather than every `Fallout4ModHeader.Mask`
field. `Fallout4ModHeader.Mask<TItem>` has exactly 16 members; the two tables below account for all
16, so the partition can be verified against the type rather than trusted:

| Allow-listed field | Subrecord | Checked with a test that corrupts it alone (both `ModelIdentityTests` and `TrackServiceTests`) |
|---|---|---|
| `TypeOffsets` | OFST | yes |
| `Deleted` | DELE | yes |
| `Screenshot` | SCRN | yes |
| `INTV` | INTV | yes |
| `INCC` | INCC | yes |
| `Author` | CNAM | yes |
| `Description` | SNAM | yes |

`Author`/`Description` were checked empirically before joining this list, not assumed:
`OpaqueHeaderFieldsRoundTripTests` proves both survive the whole-mod JSON door with distinguishable
values, and `Mutagen.Bethesda.Core`'s `ModHeaderWriteLogic` (the shared write path every header write
goes through) never touches either field — the same "nothing normalizes it on write" logic that puts
the other five fields on this list.

| Excluded field | Why excluded |
|---|---|
| `Flags` | Write-time-derived from `IsMaster`/`UsingLocalization`/`IsSmallMaster` — a legitimate normalization, not opaque data. |
| `FormID` | Always `0` on a header record; structurally inert. |
| `Version`, `FormVersion`, `Version2` | Well-typed, semantically interpreted format fields, not opaque byte data. |
| `Stats` (`NumRecords`/`NextFormID`) | This same write's own `NoNextFormIDProcessing`/`RecordCountOption.NoCheck` skip Mutagen's recompute rather than force agreement — whatever the codec parsed survives the write untouched, so a divergence here would be a codec question, not a Track-gate one. |
| `MasterReferences` | ADR-0038's content-derived master pruning is a confirmed, currently-tested legitimate divergence (`MasterPruningRoundTripGateTests`, real fixtures). |
| `OverriddenForms` (ONAM) | `OverriddenFormsOption` is its own write option with a legitimate divergence path. |
| `TransientTypes` (TNAM) | **Not a legitimate-divergence exclusion — a confirmed gap in what this mechanism can detect**, deliberately not papered over. `Fallout4ModHeader.Mask.TransientTypes` is a nested indexed-list mask; a per-item corruption is reported by the shared mask-walking helper against the nested leaf's own declaring type (`TransientType`/`FormType`), never against the outer `TransientTypes` name this allow-list would need to match — reproduced live: a per-item `FormType` corruption yields no allow-list match. A list-count divergence is worse: Mutagen's own generated mask does not flag a 1-item-vs-0-item list as unequal at all, confirmed live, so no field-name mapping fix could catch that shape either. A corrupted or dropped `TransientTypes` entry round-trips silently through this gate today; tracked as a follow-up, not fixed here. |

The seven allow-listed fields are exactly the ones Mutagen's own model never interprets and never
normalizes on write — carried through as raw data — which is why a content corruption on one of them
is a real defect rather than an encoding artifact, and why a blanket sweep of every `Mask` field would
instead false-positive-refuse the `MasterReferences`/`Stats` cases above (the two rows with their own
permanent accept fixtures) as well as silently over-claim coverage `TransientTypes` cannot actually
back.

Everything else that changes bytes without changing content — zlib level/implementation,
negative zero, subrecord order, GRUP child order, derived sizes and counts, master pruning
(decision 4 below has its own interaction: the tree carries the original's order, a compile back
out of it emits Mutagen's own) — is **documented here, not gated**: a real plugin written by
CK/xEdit/another tool is no longer refused for encoding-only differences. Track logs which of
these an accepted plugin's first Save & Compile will lose, so nothing is silent — informational
only, not surfaced on the API response (a categorized report is a
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
at Track and nothing is compared at load. Compatibility is observed, not predicted: a
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

- **Spriggit as format specification.** The source tree adopted
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
- **Committed binary + commit-compiles hook.** Once the text is lossless, a committed binary only guards against our own codec bugs;
  a second plugin copy confuses "which one is real?" and makes git see every external tool's
  edit as binary dirt; and with no pair to keep honest the hook degrades to auto-compile on
  commit, reversing ADR-0041's ungated commit for no remaining invariant.
- **A stored format-identity stamp with load-time refusal.** A version mismatch is a *guess* that the source won't compile, wrong
  both ways: it refuses mods that round-trip fine and says nothing about a hand edit that
  doesn't. Compile itself is the signal.
- **Fork Spriggit / ask for a library / per-record API upstream.** Tool packaging, .NET target
  and exact Mutagen pins all mismatch, and it binds us to their version on their schedule.
- **A local `[N] ` prefix on `Responses/` only, byte-identical to a hoped-for upstream fix** —
  moot: numbering every folder-split list is our format's definition.
