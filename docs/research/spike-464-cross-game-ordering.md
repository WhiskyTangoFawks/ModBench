# Spike #464 — folder-split ordering loss across Skyrim, FO4, Starfield: findings

The gating question (#459, triage session 2026-08-21): the Spriggit folder-split layout
carries no child order — is that exposure FO4-specific or general? Option D (targeted
`[N] ` filename prefixes on order-sensitive folder-split children) is blocked on this
answer.

Probe code is throwaway and lives only on branch `spike-464-cross-game-ordering`
(`MEditService.Tests/RealData/Spike464CrossGameOrderingProbeTests.cs`); this document is
the deliverable. Measurements 2026-08-22, dev machine, Mutagen 0.53.1 (Fallout4 +
Skyrim + Starfield record models, spike branch only), binary overlays over the local
Steam installs (current as of the measurement date) and the committed hermetic fixture.
The measurement harness was validated red/green against #459's published FO4 numbers
before being pointed at the other games: all five damage numbers reproduced exactly
(#459's "769 DIALs" reconciled as DIALs-holding-INFOs; the fixture has 860 DIAL records,
91 with empty `Responses`).

## Verdict up front

**General, not FO4-specific — with a sharp per-game severity gradient, and one clean
simplification: `DialogTopic.Responses` is the *only* order-sensitive folder-split
relationship in all three games.**

| Game | In-record order carrier | Verdict |
|---|---|---|
| Fallout 4 | **None** (0 PNAM in 78,087 full-master INFOs) | **Exposed, always** — GRUP order is the sole carrier; option D required |
| Skyrim SE | PNAM — **0% in the masterless base master, 100% in every mastered plugin** | **Exposed** — masterless plugins are FO4-class; even at 100% PNAM, ~1.3% of multi-INFO DIALs are chain-underdetermined and ~0.9% carry a chain that *disagrees* with GRUP order; round-trip fidelity needs GRUP order regardless |
| Starfield | TIFL — 100% populated, 100% set-match, **order diverges from GRUP in 75% of multi-INFO topics** | **Behaviourally immune, byte-unfaithful** — TIFL is the order carrier and rides in-record (Spriggit round-trips it); GRUP order is CK creation-order noise. Losing it changes bytes, not behaviour |

## The inventory (reflection, validated against FO4's generated code)

Method: reflection over each game assembly for major-record-list properties on
major-record types — the exact shape `MajorRecordListFieldGenerator.Applicable`
folder-splits. Validated before use: the FO4 reflection result matches FO4's generated
`WriteMajorRecordList` call sites exactly.

| Game | Folder-split after Spriggit's embed customization | Order-sensitive |
|---|---|---|
| FO4 | `Quest.{DialogBranches, DialogTopics, Scenes}`, `DialogTopic.Responses` (Cell children embed) | `DialogTopic.Responses` only (#459's table) |
| Skyrim SE | `DialogTopic.Responses` only — DIAL/DLBR are top-level groups, no Quest children | `DialogTopic.Responses` only |
| Starfield | identical to FO4: `Quest.{DialogBranches, DialogTopics, Scenes}`, `DialogTopic.Responses` | `DialogTopic.Responses` only |

The quest-children groups are addressed by FormID in every game (#459 established this
for FO4; the same `CompareGroupContents` canonical-order machinery covers all three).
So the per-game declaration the triage session anticipated collapses to **one
relationship, present in all three games, differing only in severity**.

## Numbers

| Measurement | FO4 fixture | FO4 full | Skyrim.esm | Skyrim DLCs (4 files) | Starfield.esm | Prior reference (#459) |
|---|---|---|---|---|---|---|
| DIALs (non-empty) | 860 (769) | 35,443 (32,681) | 15,037 (14,904) | 4,807 (4,662) | 68,154 (63,460) | 769 (fixture, non-empty) |
| INFOs | 2,873 | 78,087 | 31,465 | 9,723 | 126,347 | 2,873 |
| PNAM populated | 0 | 0 | **0 (0.0%)** | **9,723 (100%)** | n/a — no PNAM field in the model | 0 |
| Multi-INFO DIALs | 283 | 7,749 | 2,757 | 1,197 | 10,014 | 283 |
| Permuted by filename sort | 96 (34%) | 2,264 (29%) | 713 (26%) | 232 (19%) | 1,514 (15%) | 96 of 283 |
| Slots moved | 1,540 | 28,889 | 10,064 | 2,014 | 29,072 | 1,540 |

Filename sort is the quasi-alphabetical NTFS proxy #459 used; arbitrary readdir order
(ext4 htree) bounds damage at *all* multi-INFO parents in every game.

## Findings

1. **FO4's PNAM absence holds at full-master scale.** 0 populated PNAM across 78,087
   INFOs in `Fallout4.esm` — #459's fixture measurement was not a subset artifact. GRUP
   order is the sole carrier, everywhere, always.

2. **Skyrim's PNAM is an authored-against-masters phenomenon, not a game property.**
   `Skyrim.esm` (masterless): 0 of 31,465 INFOs carry PNAM — verified independently
   with a raw byte-level subrecord scan (no Mutagen), which also reproduced the DIAL and
   INFO counts exactly. Every DLC master (`Update`, `Dawnguard`, `HearthFires`,
   `Dragonborn`): **100%** of 9,723 INFOs carry PNAM. The CK omits PNAM in a base
   master and writes it on every INFO of a plugin authored against masters — which is
   the tracked-mod case, but "masterless plugin" is not exotic (any total-conversion or
   standalone-master mod).

3. **Even full PNAM is not a sufficient order carrier.** Across the DLCs' 1,197
   multi-INFO DIALs: 1,171 (97.8%) chains reconstruct GRUP order exactly; **15 (1.3%)
   are underdetermined** (multiple heads after external references — insertion into a
   master's topic — or incomplete coverage); **11 (0.9%) reconstruct a *different*
   order than GRUP** (the engine follows the chain there; xEdit's INOM/INOA exists
   precisely to visualize this). Zero duplicate-claimant ties observed in vanilla data,
   but nothing prevents them (two mods inserting after the same INFO is the classic
   case — xEdit's three-input model, `whatsnew.md` INOM/INOA section). A PNAM-based
   recovery is therefore engine-equivalent *at best* and wrong for 1.3% of topics —
   and Modbench's contract is round-trip fidelity, not engine-equivalence.

4. **Starfield's TIFL is the order carrier, and GRUP order is noise.** In
   `Starfield.esm`, TIFL is populated on 100% of multi-INFO topics with a perfect
   FormKey set-match against the child GRUP — and its order **diverges from GRUP order
   in 7,516 of 10,014 (75%)**. If GRUP order were behavioural, three-quarters of
   vanilla dialogue would be misordered; TIFL divergence at this rate is only
   consistent with TIFL being authoritative (Bethesda's own fix for exactly the
   problem #459 documents — an in-record carrier decoupled from record position).
   Corroborating: xEdit models TIFL as `wbArray` — unsorted, order is data
   (`wbDefinitionsSF1.pas:11917`) — and sets `wbCanSortINFO := False` for SF1
   (`xeInit.pas`), i.e. it never reorders Starfield INFOs. TIFL rides inside the
   DialogTopic document, so Spriggit round-trips it losslessly. Caveat stated plainly:
   authority is inferred from population + set-match + divergence + xEdit's treatment +
   design intent, not proven from engine disassembly.

5. **Skyrim needs no game-specific mechanism despite PNAM.** Because PNAM rides
   in-record (Spriggit preserves it) and GRUP order must be preserved anyway (findings
   2–3), the fix for Skyrim is identical to FO4's: preserve GRUP order in the layout.
   No PNAM synthesis, no chain reconstruction — the #459 trap ("do not synthesise a
   PNAM chain") stays ruled out.

6. **A structural constraint for future multi-game work, found incidentally:** the
   Serialization source generator produces colliding cross-game code when more than one
   game assembly is visible in the project that hosts it (920 errors observed adding
   Skyrim/Starfield to `MEditService.Core`). Game-typed whole-mod seeds will need
   per-game assemblies or generator-scoping — a real cost item for the multi-game
   serialization milestone, not for #459.

## What this unblocks (decisions, not conclusions)

- **Option D is confirmed as the right shape, and simpler than triaged:** the
  "per-game declaration of order-sensitive folder-split relationships" collapses to one
  entry — `DialogTopic.Responses` — valid for all three games. FO4 and Skyrim need it
  for correctness; Starfield needs it only if byte-fidelity of GRUP order is wanted
  (behaviour is TIFL-carried). Recommendation: apply D uniformly to
  `DialogTopic.Responses` wherever the layout folder-splits it — one rule, no per-game
  branching, and the Starfield case costs nothing while buying byte-stable round trips.
- **Recommended follow-up tickets** (per the triage session's harness-first decision):
  1. FO4 integration tests promoting this spike's and #459's prose numbers to
     asserted-present tests against the hermetic fixture — the harness D's
     implementation flips (the 96-permuted number goes to zero; the
     `SourceIngestParityTests` 233-parent allowlist pin goes to zero).
  2. Skyrim/Starfield ordering tests ride the multi-game serialization milestone (they
     need game-typed whole-mod seeds, which hit finding 6); this spike's numbers are
     their oracle when they land. Not blockers for #459.
- **#459's final design pass** can proceed: prefix maintenance on point writes,
  gate/allowlist flips, the `RecordTextCodecCustomization.cs` false-justification
  rider — scope now known.
