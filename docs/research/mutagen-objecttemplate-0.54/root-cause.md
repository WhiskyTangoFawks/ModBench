# Mutagen 0.54.0 ObjectTemplate round-trip regression (#385)

Investigation for MEditService issue #385. We are pinned to Mutagen 0.53.1
(`MEditService/MEditService.Core/MEditService.Core.csproj`); this document, the
regression test, and the backport patch are prepared for the Mutagen maintainer
to turn into an upstream PR. **No upstream issue or PR was opened as part of
this work** — a report was briefly filed and withdrawn
(Mutagen-Modding/Mutagen#683); the eventual PR may reference it.

## Correction to the issue's original framing

The issue as filed suspected commit `5f76fffc` ("Fo4 ObjectTemplate's STOP
marker absorbed as endMarker") as the fix, and named `0.55.0-alpha.7` as the
first confirmed-good version. Both are corrected by the evidence below, exactly
as MAINTAINER COMMENT 1 on the ticket anticipated:

- `5f76fffc` is dated 2022-03-24 and is an ancestor of **both** `0.53.1` and
  `0.54.2`. It predates this regression by roughly four years and is unrelated
  to it.
- The real regression was introduced by commit `aa7cc540e` ("Standardize
  RecordType ordering", 2026-06-22) and the real fix is commit `6aa769dab`
  ("Reverted record type ordering", 2026-07-07) — an isolated, exact revert of
  `aa7cc540e`'s change to this one file. It first shipped in `0.54.2`, not
  `0.55.0-alpha.7` (`0.55.0-alpha.7` also contains it, since dev history is
  linear past that point, but it is not the first fixed version).

This is the "alphabetization simply reverted by regeneration" scenario: no new
logic was written, the commit that introduced the bug was walked back.

## Mechanism (read from source, not inferred)

FO4 `ObjectTemplate` is a subrecord with three fields, written in this order
(`Mutagen.Bethesda.Fallout4/Records/Common Subrecords/ObjectTemplate.xml`):

```
<Bool name="IsEditorOnly" recordType="OBTF" boolAsMarker="True" />
<String name="Name" recordType="FULL" translated="Normal" />
<CustomLogic name="OBTSLogic" recordType="OBTS" />
```

So genuine on-disk order for one template is **OBTF, FULL, OBTS** (OBTF is a
zero-length marker subrecord, omitted entirely when `IsEditorOnly` is false).

The list of `ObjectTemplate`s inside a `Weapon` record
(`Records/Major Records/Weapon.xml`, field `ObjectTemplates`, counter `OBTE`,
end marker `STOP`) has no per-item header — item boundaries are inferred
positionally. The lazy overlay reader does this via
`PluginBinaryOverlay.ParseRecordLocationsInternal`
(`Mutagen.Bethesda.Core/Plugins/Binary/Overlay/PluginBinaryOverlay.cs:480-528`
at the tags cited below): it walks the subrecord stream and starts a new list
item whenever `trigger.AllRecordTypes.IndexOf(recType)` **fails to strictly
increase** compared to the previous subrecord's index — i.e. it uses each
`ObjectTemplate`'s own field-declaration order as an implicit "item started
over" signal.

`ObjectTemplate_Registration`'s `_recordSpecs`
(`Records/Common Subrecords/ObjectTemplate_Generated.cs`, generated from the
XML field order above) supplies that `AllRecordTypes` list:

- **0.53.1** (commit `bdbb6ff6f`) and **dev before 2026-06-22**:
  `RecordCollection.Factory(RecordTypes.OBTF, RecordTypes.FULL, RecordTypes.OBTS)`
  — `OBTF=0, FULL=1, OBTS=2`. On-disk order OBTF→FULL→OBTS maps to indices
  0→1→2, strictly increasing throughout: one template parses as one item.

- Commit `aa7cc540e` ("Standardize RecordType ordering", 2026-06-22, first
  released in **0.54.0**) alphabetizes this to
  `Factory(RecordTypes.FULL, RecordTypes.OBTF, RecordTypes.OBTS)` —
  `FULL=0, OBTF=1, OBTS=2`. The **same on-disk bytes**, OBTF→FULL→OBTS, now map
  to indices 1→0→2: the OBTF→FULL step is a *decrease*, so the scanner ends the
  "current" item right there and starts a new one at FULL. A single on-disk
  template is read back as two overlay items (one holding OBTF, a bogus
  follow-on holding FULL+OBTS). The write path then faithfully serializes
  however many items the overlay produced, so every read→write cycle grows the
  file. `Fallout4Mod.CreateFromBinary` (the deep parse) walks the list using
  the counter (`OBTE`) and the `STOP` end marker directly and never consults
  `AllRecordTypes.IndexOf` for boundary detection, so it is unaffected — this
  asymmetry (deep parse immune, lazy overlay affected) is the load-bearing
  fact behind both the production-save-path test and the regression test
  below.

- Commit `6aa769dab` ("Reverted record type ordering", 2026-07-07, first
  released in **0.54.2**) restores `Factory(OBTF, FULL, OBTS)` — an exact,
  isolated inverse of `aa7cc540e`'s change to this one file. Confirmed via
  `git diff 0.54.0 6aa769dab~1 -- ".../ObjectTemplate_Generated.cs"` being
  empty in the upstream clone: no other commit touched this file between the
  regression landing and the revert, so the fix is genuinely a clean 2-line
  swap, not entangled with anything else in that commit (which also reverted
  unrelated ordering changes in ~20 other files for other record types, per
  its message "Ordering is actually used for logic").

Two corrections to the original brief, both confirmed: empty `Name` fields are
a red herring (the trigger is on-disk subrecord *order*, not content); the
mechanism fires on any weapon whose template writes OBTF (any
`IsEditorOnly=true` template), not something specific to the four named
weapons — they are simply the four in the committed fixture that happen to
carry `IsEditorOnly=true` templates.

## Version matrix (rebuilt from a clean environment)

Reproduced with a fresh probe (`Fallout4Mod.CreateFromBinaryOverlay` →
`BeginWrite` → reload → write again, exactly
`BinaryRoundTripGateTests.LazyOverlayReloadAndRewrite_ProducesByteIdenticalOutput`'s
shape) against the committed fixture
`MEditService/MEditService.Tests/TestData/mEditTestSubset.esm`
(767,753 B, sha256 `934fd93065085b9c45297c37670e992928ecefdd4e0ab17e1f61256f05eaf637`),
built fresh per Mutagen version via NuGet (no cached probes reused: the #359
throwaway probes did not survive, as expected, and these are new).

| Version | Source commit | write1 | write2 | original==write1 | write1==write2 | Overlay ObjectTemplates (4 weapons) | Deep-parse ObjectTemplates (4 weapons) |
|---|---|---|---|---|---|---|---|
| 0.53.1 | `bdbb6ff6f` | 767,753 | 767,753 | true | true | 5, 2, 5, 11 | 5, 2, 5, 11 |
| 0.54.0 | `28488177e` | 769,026 | 770,299 | **false** | **false** | 10, 3, 9, 22 | 5, 2, 5, 11 |
| 0.54.1 | `28488177e` (**same commit as 0.54.0** — see footnote) | 769,026 | 770,299 | **false** | **false** | 10, 3, 9, 22 | 5, 2, 5, 11 |
| 0.54.2 (first fixed) | `282bb99a7` | 767,753 | 767,753 | true | true | 5, 2, 5, 11 | 5, 2, 5, 11 |
| 0.55.0-alpha.7 (secondary confirmation, as named in the original issue) | `e04a40e18` (from the nupkg's embedded SourceLink `repository commit`, branch `dev`; no git tag exists for prerelease versions — they are commit-distance-numbered CI builds) | 767,753 | 767,753 | true | true | 5, 2, 5, 11 | 5, 2, 5, 11 |

Byte deltas match the issue's original spike (#359) exactly: 767,753 →
769,026 → 770,299, +1,273 B per cycle at 0.54.0.

The four weapons (`FormKey`s `24A3AF:Fallout4.esm`, `24A3B0:Fallout4.esm`,
`24A3B1:Fallout4.esm`, `24A3B2:Fallout4.esm` — `VRWorkshopShared_*`) are listed
in FormKey order above, not the maintainer comment's order; the counts are the
same multiset (`{5,2,5,11}` deep / `{10,3,9,22}` overlay) either way. Overlay
counts roughly double the deep-parse counts but not exactly (e.g. 2→3, not
2→4) — an artifact of where each template's spurious split boundary falls
relative to the list's end, not evidence against the mechanism.

**Footnote on 0.54.1**: `git rev-list -n1 0.54.0` and `git rev-list -n1 0.54.1`
resolve to the identical commit hash `28488177e3cf787c7b676de5ffe0242e9fc107d3`.
0.54.1 is not a source change at all — whatever prompted that patch version
bump did not include this fix (or any other Fallout4 change). Anyone reading
the version table and assuming patch bumps monotonically improve should not
assume that of 0.54.1 specifically.

## Backport verification: patched 0.54.0 is byte-stable

Isolated 2-line backport of `6aa769dab` onto the `0.54.0` tag, touching only
`ObjectTemplate_Generated.cs`'s `_recordSpecs` (restores
`Factory(OBTF, FULL, OBTS)`): [`backport/0001-Fo4-ObjectTemplate-restore-OBTF-FULL-OBTS-registrati.patch`](backport/0001-Fo4-ObjectTemplate-restore-OBTF-FULL-OBTS-registrati.patch),
generated with `git format-patch -1` from a branch cut at the `0.54.0` tag.

Built locally (`ProjectReference` to the patched `Mutagen.Bethesda.Fallout4`/
`Core`/`Kernel` projects, `net9.0` only) and rerun through the same probe:

```
original=767753 write1=767753 write2=767753
original==write1: True
write1==write2: True
24A3AF: overlay.ObjectTemplates.Count=5 deep.ObjectTemplates.Count=5
24A3B0: overlay.ObjectTemplates.Count=2 deep.ObjectTemplates.Count=2
24A3B1: overlay.ObjectTemplates.Count=5 deep.ObjectTemplates.Count=5
24A3B2: overlay.ObjectTemplates.Count=11 deep.ObjectTemplates.Count=11
```

Identical to 0.53.1/0.54.2/0.55.0-alpha.7. The isolated backport is sufficient
on its own — the maintainer does not need the full multi-file revert commit to
fix this, only this one hunk.

## Upstream-shaped regression test

[`regression-test/ObjectTemplateOrderRegressionTests.cs`](regression-test/ObjectTemplateOrderRegressionTests.cs)
+ fixture [`regression-test/ObjectTemplateOrder.esp`](regression-test/ObjectTemplateOrder.esp)
(316 B) — ready to drop into
`Mutagen.Bethesda.UnitTests/Plugins/Records/Fallout4/` and
`Mutagen.Bethesda.UnitTests/Files/Fallout4/` respectively.

**Shape chosen**: Mutagen's own test suite already has a precedent for exactly
this situation —
`Mutagen.Bethesda.UnitTests/Plugins/Records/ASpecificCaseTest.cs`'s
`ASpecificCaseTest<TSetter, TGetter>` base class, used elsewhere for Fallout4
fixtures (e.g. `ObjectModificationCanImportNoDataTest`,
`Fallout4LeveledItemChanceNoneTests`). It drives a small committed
single-record fixture (raw record bytes under `Files/<Game>/*.esp`, read
directly with `File.ReadAllBytes` — no mod-header/GRUP framing) through two
`[Theory]` methods: `Direct` (deep parse via `LoquiBinaryTranslation<TSetter>`)
and `Overlay` (lazy overlay via `LoquiBinaryOverlayTranslation<TGetter>`), each
followed by an inherited byte-identical write-back assertion
(`TestPassthrough`, true by default). This maps exactly onto the mechanism:
`Direct` exercises the immune path, `Overlay` exercises the affected one, from
one fixture, for free — no need to write a separate round-trip test alongside
a separate count assertion.

The subclass: `TSetter=Weapon, TGetter=IWeaponGetter`, fixture = one WEAP
record with one `ObjectTemplate` (`IsEditorOnly=true` so OBTF is present,
`Name` set so FULL is present, giving genuine on-disk order OBTF, FULL, OBTS).
`TestItem` asserts `item.ObjectTemplates!.Count == 1` — the sharp probe: it
fails on the very first `Overlay` parse, before the inherited round-trip
assertion even runs, and localizes to the reader rather than the writer.

**Fixture construction** (documented so the maintainer can regenerate it):
[`regression-test/generate-fixture/Program.cs`](regression-test/generate-fixture/Program.cs)
(+ its `.csproj`, pinned to Mutagen 0.53.1 — the known-correct, immune
baseline) builds a one-weapon `Fallout4Mod` with the `ObjectTemplates` entry
described above, writes it to a full `.esp` via the public `BeginWrite` API,
then slices out just the `WEAP` record's bytes (skipping the `TES4` header
record and the `WEAP` `GRUP` header — 24 bytes each) to produce the raw
single-record fixture `ASpecificCaseTest`'s `TestDataPathing` expects. Run
with `dotnet run -- <output-path>`.

**Observed failing at 0.54.0, passing at 0.54.2 and at the patched 0.54.0**
(required — not assumed): built a minimal harness assembly (named
`Mutagen.Bethesda.UnitTests` to satisfy `Mutagen.Bethesda.Core`'s
`InternalsVisibleTo`, since `OverlayStream`'s constructor used by
`TestDataPathing` is `internal`) containing unmodified copies of
`ASpecificCaseTest.cs` and `TestDataPathing.cs` plus the new test and fixture,
run via `dotnet test` against each Mutagen version in turn:

- **0.53.1**: `Direct` and `Overlay` both pass.
- **0.54.0**: `Direct` passes; `Overlay` **fails**:
  ```
  Shouldly.ShouldAssertException : item.ObjectTemplates!.Count
   should be
  1
   but was
  2
  ```
  at `ObjectTemplateOrderRegressionTests.TestItem`, called from
  `ASpecificCaseTest<Weapon,IWeaponGetter>.Overlay`. Exactly the predicted
  asymmetry.
- **0.54.2**: `Direct` and `Overlay` both pass again.
- **patched 0.54.0** (the backport branch, via `ProjectReference`): `Direct`
  and `Overlay` both pass.

## For the maintainer

1. Apply `backport/0001-Fo4-ObjectTemplate-restore-OBTF-FULL-OBTS-registrati.patch`
   (a `git format-patch` of a single commit cut from the `0.54.0` tag) to
   whichever release branch needs the fix.
2. Drop `regression-test/ObjectTemplateOrderRegressionTests.cs` into
   `Mutagen.Bethesda.UnitTests/Plugins/Records/Fallout4/` and
   `regression-test/ObjectTemplateOrder.esp` into
   `Mutagen.Bethesda.UnitTests/Files/Fallout4/`.
3. `regression-test/generate-fixture/` regenerates the fixture if it ever
   needs to change.

## MEditService side effects

None. Our pin stays 0.53.1 per ADR-0040/#369 until this is fixed upstream and
we choose to move; #369's `LazyOverlayReloadAndRewrite_ProducesByteIdenticalOutput`
remains the permanent gate against a silent regression on a future bump. This
document, the regression test, and the backport patch are research artifacts
only — no code, test, or pin in this repo changed.
