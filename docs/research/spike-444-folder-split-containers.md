# Spike #444 — #387's container defects vs the whole-mod folder-split path: findings

Answers the gating question of epic #444 ("nothing else is plannable until this
answers"): do the two container defects that forced ADR-0041's shallow-strip —
found on the *per-record* generated serialization path during #387 — also apply
to the *whole-mod folder-split* path, the one Spriggit uses and the one an
ingest-from-source / containment-as-folder-structure design would stand on?

Probe code is throwaway and lives only on branch
`spike-444-folder-split-containers`
(`MEditService.Tests/RealData/Spike444FolderSplitProbeTests.cs`); this document
is the deliverable, alongside a read-through of
`references/mutagen-serialization` (1.38.6 clone; release notes confirm no
folder-split layout changes since our 1.37.1 pin) and `references/spriggit`.
Measurements 2026-08-21, dev machine, Mutagen 0.53.1 + Serialization 1.37.1,
JSON kernel (the production codec's own), through the generated
`MutagenJsonConverterFallout4ModMixIns` — the whole-mod API production code is
forbidden to call (guard scans `MEditService.Core` sources only; the spike is
Tests-side, on a branch that never merges).

## Verdict up front

**Both #387 defects are per-record-path artifacts. The whole-mod folder-split
path has neither, by construction — probe-confirmed on real data.** The
shallow-strip's reason for existing does not apply to a folder-split design.

| #387 defect (per-record path) | Whole-mod folder-split path |
| --- | --- |
| Child folders keyed by field name only → two cells serialized into one directory silently merge children; deserializing cell A returns both cells' refs | **Absent.** Every container record gets its own directory keyed by `<EditorID> - <FormKey>`; the writer's `StreamPackage.Path` is repointed *into* that directory before children are written (`BlockParallelHelper.cs:81-93`, `XYBlockParallelHelper.cs:192-204`), so field-name-keyed child folders resolve inside a per-record namespace. FormKey uniqueness within a mod guarantees no sharing. Probe: two interior cells in one sub-block, each with persistent + temporary refs — each read back exactly its own. |
| `Worldspace_Serialization.Serialize` never touches `SubCells` — the entire exterior hierarchy is silently dropped | **Absent, and the per-record symptom is by design.** Under `FilePerRecord()`, `BlocksXYFieldMemberBlocker` deliberately *removes* `SubCells` from the per-record serializer because the mod-level group writer (`AddXYBlocksToWork`) owns it. The whole-mod path writes and reads the full XY hierarchy. Probe: worldspace with XY block/sub-block, two exterior cells with children, `TopCell` — full round trip, grids intact. |

Also probed: two quests each carrying a dialog topic + response — each quest's
dialog stays its own (`Quests/<quest>/DialogTopics/<topic>/Responses/...`).

## The layout (probe-observed, JSON kernel, our current customization)

```
<modDir>/
  RecordData.json                                  ← the mod header — #444's "no source file" gap, closed for free
  Weapons/
    <EditorID> - <FormKey>.json                    ← childless record: flat file
  Cells/
    GroupRecordData.json
    0/0/                                           ← block / sub-block numbers
      <EditorID> - <FormKey>/                      ← each cell: its own directory
        RecordData.json                            ← the cell's own fields
        Persistent/ Temporary/ NavigationMeshes/   ← children, one file each, inside the cell's dir
  Worldspaces/
    <EditorID> - <FormKey>/
      RecordData.json                              ← worldspace's own fields
      TopCell/RecordData.json
      0, 0/0, 0/                                   ← XY block / sub-block ("X, Y" dirs)
        <EditorID> - <FormKey>/…                   ← per-cell dirs again
  Quests/
    <EditorID> - <FormKey>/
      RecordData.json
      DialogTopics/<EditorID> - <FormKey>/
        RecordData.json
        Responses/<FormKey>.json
```

A record with no EditorID gets a bare `<FormKey>.json` name. Empty groups write
no `GroupRecordData`; readers tolerate absence, silently skip unparseable
directory names, and can even reconstruct a missing worldspace `RecordData`
from its folder-name FormKey.

Note what the path encodes: **EditorID is in the file/directory name.** An
EditorID edit is a rename+content change in git; the FormKey suffix keeps
identity stable and machine-recoverable.

## Numbers

| Measurement | Value | Prior reference |
| --- | --- | --- |
| Whole-mod JSON serialize, 768 KB subset | **1.5 s, 3,943 files, 3.7 MB** | #359 YAML: 2.2–3.9 s, same file count |
| Whole-mod JSON deserialize, 768 KB subset | **843 ms** | — |
| Re-serialize after round trip | 573 ms, **byte-identical in all 3,943 files** | #359 Q1 text stability, now on JSON |
| Deep parse 20 MB binary (`AmericaRising2.esm`) | 2.0 s | — |
| Whole-mod JSON serialize, 20 MB | **14.6 s, 132,787 files, 123 MB** | #359 YAML: 21 s, 106 MB |
| Whole-mod JSON deserialize, 20 MB | **6.6 s** | — |

The deserialize column is the shape of #444's second spike question
(ingest-from-source at session load): sub-second for a typical mod, single-digit
seconds for a 20 MB mega-plugin — and that is the *cold, whole-tree* cost before
any clean-fast-path (hash-unchanged) shortcut. Serialize cost is paid at Track,
which ADR-0041 already prices ("worst case ~21 s"; JSON is ~30% cheaper).

## Spriggit compatibility facts (for the dependency-ladder decision)

1. **The layout is 100% the serialization library's folder-split output.**
   Spriggit adds no layout of its own — only two sidecars (`spriggit-meta.json`
   beside the tree; the optional hand-written `.spriggit` pin file:
   `{PackageName, Version, Release, KnownMasters[]}`) plus a `SpriggitSource`
   extraMeta object *inside* the root `RecordData`. The mixin's `extraMeta`
   parameter is exactly the hook for writing pin metadata into the header file.
2. **One deliberate divergence:** every Spriggit translation package applies
   `EmbedRecordsInSameFile` for `Cell.{Persistent,Temporary,Landscape,
   NavigationMeshes}` and `Worldspace.TopCell` — real Spriggit cell output is a
   single `RecordData` with placed records **inline**, no child folders. That
   knob exists in our 1.37.1 pin. Whether to adopt it is a genuine design
   choice, not a feasibility question: embedding buys byte-level Spriggit
   parity but re-couples a cell's document to its children (a placed-ref edit
   dirties the cell's file; the index's one-record-one-document mapping bends),
   while child-folder layout keeps one record = one file at the cost of a
   layout-level (still losslessly convertible) divergence from Spriggit.
3. **Version ladder:** Spriggit pins Serialization **1.38.6**, which hard-requires
   Mutagen **≥ 0.54.0** (nuspec) — the release with the #385 ObjectTemplate
   regression our pin exists to avoid. 1.38.x adds `SortList` (deterministic
   ordering of CK-shuffled lists), `OmitUnknownGroupData`,
   `OmitUnusedConditionDataFields`. **Consequence: byte-level Spriggit parity is
   gated on #385 resolving upstream; layout-level parity is achievable today.**
4. **A real defect in the whole-mod path** (upstream-report candidate, #385
   pattern): `MajorRecordListParallelHelper.cs:34-50` mutates the *captured*
   `streamPackage` inside its parallel per-record lambda — under a genuinely
   parallel `IWorkDropoff` two nested records (e.g. dialog topics) can write
   into each other's folders. Benign sequentially (the null-dropoff default our
   probes ran under, hence byte-stable results). Any production use must pin a
   sequential/inline dropoff for nested-list containers until fixed upstream.
5. Upstream test coverage asserts exact folder-split layouts but never two
   cells in one sub-block with children — our probe is the first empirical
   confirmation of the non-collision property; worth contributing upstream.

## Addendum: embed probes (same day, after the design rounds settled on Spriggit parity)

With Spriggit's exact embed customization applied to our generated serializers
(`Cell.{Temporary,Persistent,Landscape,NavigationMeshes}`, `Worldspace.TopCell`
— their `CellCustomization`/`WorldspaceCustomization` minus the 1.38-only
`SortList`; the `EmbedRecordsInSameFile` knob exists in 1.37.1):

**Layout under embed.** A cell keeps its own directory (the block helper's
structure) but it contains exactly one file:
`Cells/<b>/<sb>/<EditorID> - <FormKey>/RecordData.json`, children inline.
`TopCell` embeds into the worldspace's own `RecordData.json`. All container
probes re-pass; the real-subset round trip stays byte-stable.

**Mega-plugin, embedded:** serialize **5.8 s, 19,430 files** (from 14.6 s /
132,787 files un-embedded — placed records were the bulk of the file count),
deserialize **5.1 s**. Embed is also a large operational win: 85% fewer files
per tracked mega-mod.

**Byte-equality of the two doors (the uniformity assumption).** The per-record
codec's output for an embedded cell vs the whole-mod path's file for the same
cell: **identical except exactly two deltas, both our own codec's choices**,
pinned by probe 6:

1. The codec writes a top-level `MutagenObjectType` discriminator on every
   record (it dispatches through the abstract serializer so documents
   self-describe). The whole-mod path writes a top-level discriminator **only
   when the group's element type is abstract** (path-ambiguous — e.g. Globals,
   where GLOB splits into GlobalFloat/GlobalBool/…); a Cell's group element is
   concrete, so its file has none. Embedded children (`IPlaced` is abstract)
   carry discriminators identically on both sides — the kernel's own rule.
   *Disposition:* the codec adopts the whole-mod policy; `record_type` is
   already an index column, and files self-describe exactly when the path
   can't.
2. The codec appends exactly one trailing `\n` (its own canonical-formatting
   addition); the kernel ends at the closing brace, as Spriggit trees do.
   *Disposition:* byte parity wins — drop the codec's trailing newline; the
   canonicalization clause (bare `\n`, no trailing newline) moves to the ADR,
   with Windows `\r\n` behavior of the whole-mod door to be verified at
   implementation (the parity gate adjudicates).

With both deltas dispositioned, **one document shape everywhere holds at the
byte level**: untracked ingest (per-record from binary), tracked ingest (files),
and point writes all produce/consume the same bytes for the same record state.

## What this unblocks (for the ADR pass — decisions, not conclusions)

- The **shallow-strip containment posture loses its forcing function**: with a
  folder-split source tree, containment is the path, `ContainerAssembler`'s
  DB-index-row reconstruction becomes derivable from layout, and the "mod
  header has no source file" gap closes via the root `RecordData`.
- **Ingest-from-source is affordable**: 843 ms typical / 6.6 s mega-plugin cold,
  before any clean-path shortcut.
- The **whole-mod generated API prohibition** (RecordTextCodecGeneratorSeed's
  AC2 guard) was justified by the 21 s *serialize* cost on a lazy per-edit path
  and by ADR-0040's redistribution story — both superseded by ADR-0041's eager
  Track. If the ADR adopts folder-split, that guard inverts from "never call
  the whole-mod API" to "the whole-mod API is the Track/ingest door" — with the
  dropoff caveat from finding 4.
- Open design choices the ADR must make, none blocked on feasibility:
  embed-vs-child-folders (Spriggit parity vs one-record-one-file), whether the
  per-record codec survives for point writes into the folder-split tree (its
  bytes for a childless record are *not* automatically identical to the
  whole-mod path's file for that record — discriminator/context differences
  need their own probe if both paths must coexist), and the pin file /
  `extraMeta` shape.
