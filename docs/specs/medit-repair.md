# Repair — Surface Specification (malformed-plugin repair)

**Status: Specced — not built.** Grilled to closure 2026-08-27; decision recorded in [ADR-0043](../adr/0043-malformed-plugins-are-repaired-by-a-byte-level-table-driven-engine.md). Depends on the diagnosis floor — split at #519's own plan-gate (2026-08-29, past the orchestrator's slice ceiling) into #519 (the `PluginDiagnosis` core and Kind A tail), #569 (the Kind B per-class detector tables), and #570 (the Problems-panel/session-load surface, blocked on #569); every "#519" below means this ticket family unless a specific one is named. Upstream context
and the Kind A / Kind B split: #516. Survey evidence: #513 (684-plugin LitR survey,
2026-08-27); harness `MEditService.Tests/RealData/RoundTripSurvey.cs`.

Editing context — operates on plugins, records and subrecords; never on mods or downloads
([CONTEXT-MAP.md](../../CONTEXT-MAP.md)). Vocabulary: **Diagnosis**, **Malformed plugin**,
**Repair** (lossless / lossy) in [CONTEXT.md](../../CONTEXT.md); #381's journal replay is
*Crash recovery* there, so "repair" is unambiguous.

xEdit reference ([ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md)):
xEdit's answer to a malformed plugin is *tolerance* — it loads what it can, shows the rest as
unknown/hidden (`wbEPF2DontShow`, unresolved references), and **Check for Errors** reports;
the fix is manual or a Pascal script, and saving re-serializes in definition order. Repair is
therefore an opt-in power-user addition xEdit never had (permitted by the ADR-0034 amendment —
baseline, not ceiling), not a redefinition of any xEdit gesture. Its *target* is xEdit's: what
the Creation Kit would have written.

## Problem Statement

Track and Save & Compile run through Mutagen, which parses strictly. Real plugins from the
wild are not always what the Creation Kit writes: a template's subrecords out of order, a
fixed-size header two bytes short, a fixed-count list one entry short, a counter that
disagrees with the entries it counts, a perk entry-point carrying a parameter shape its
function never takes. xEdit tolerates all of these; Mutagen either throws or — worse —
silently drops what follows the anomaly. Today the user gets `MalformedDataException` with a
ModKey and no record, and no path forward inside Modbench.

Not every failure is the plugin's fault. Where the data is legitimate and Mutagen's model
is what's wrong (Kind A: Mutagen #685–#688), the answer is *refuse and name the upstream
issue* — a byte-level "repair" of correct data is data destruction and this surface must
never offer one. Repair exists only for **Kind B**: plugins malformed by the CK's own
conventions, where the canonical form is known and provable against vanilla.

## Solution

Two surfaces, one engine:

1. **Diagnosis** (the floor, #519) — every refusal names the record, subrecord, defect
   class, observed vs expected, and a suggested fix. Kind B detectors are byte-level and
   ~1 ms/plugin, so they also run at **session load** and publish Problems-panel entries —
   a silently-lossy plugin (R1, R2) parses cleanly and would otherwise look healthy until
   Track. Kind A detectors need Mutagen to throw and run only on failure. This spec assumes
   the floor owns both the detection (#569) and the Problems-panel surface (#570).
2. **Repair** — an explicit gesture on a plugin that has at least one *repairable*
   diagnosis. Shows exactly what it will change, at subrecord granularity, and writes a new
   plugin binary only on confirmation. Never invoked by Track, Compile, or any load path.

The engine is Mutagen-free: raw bytes in, raw bytes out. It knows the container format
(record header, GRUP, subrecord, `XXXX` extended length, zlib-compressed records) and a small
set of **generic operations** — it never understands a record's semantics. Per-defect
knowledge is a **table** (which subrecords, what order, what length, what count, which
counter pairs with which entries), each row backed by a vanilla-scan proof and a real fixture.

## User Stories

- As a user tracking a downloaded plugin, when Track refuses it, I want to know *which
  record and which bytes* are wrong so I can decide what to do — in Modbench, xEdit, or by
  asking the author.
- As a user, when the defect is one Modbench knows how to fix losslessly, I want to fix it
  in place with one gesture and see precisely what changed before it writes.
- As a user, when the fix would drop bytes, I want to be told that, per record, and choose —
  never have data removed silently.
- As a user with a plugin blocked by a Mutagen bug, I want to be told that it is Mutagen,
  which issue, and that there is nothing to repair — not offered a "fix" that would damage a
  correct file.
- As a mod author, I want the repaired plugin to be what the CK would have written, so
  xEdit and the game see exactly the same data they saw before.

## The surfaces

### Diagnosis (floor — #519, restated here only where Repair reads it)

- **Where**: the refusal message of Track / Save & Compile (existing path), and the
  Problems panel at session load for every plugin carrying a Kind B diagnosis (#570).
  There is no separate "Diagnose" command — the Problems entries are the diagnosis and
  Repair's QuickPick is the detailed view.
- **Shape**: `<Type> <FormKey> (<EditorID>) — <subrecord>: <defect class>; observed …;
  expected …` plus one of three tails: **Repairable (lossless)**, **Repairable (drops
  N bytes)**, or **Blocked upstream: Mutagen #NNN**.
- **Repair reads only the first two tails.** A plugin with any *Blocked upstream* diagnosis
  can still be repaired for its other defects; the refusal after repair then names only what
  remains.

### Repair

- **Where**: plugin row context menu (Plugins tree) and command palette —
  `Modbench: Repair Plugin…`. Enabled only when the plugin carries at least one repairable
  diagnosis; otherwise absent, not greyed (no dead UI). Never an icon — it writes a file
  (destructive-class gesture, [modbench/CLAUDE.md](../../modbench/CLAUDE.md) invariant 4).
- **Preview** (native, not a webview): a `QuickPick` with `canPickMany`, one item per
  repairable diagnosis, all *lossless* items pre-checked, *lossy* items **unchecked** with
  their byte cost in the description. The detail line is the subrecord-level change:
  `WEAP 03000860 (GaussPistol) template 1: OBTS OBTF FULL → OBTF FULL OBTS`.
  The user can deselect any item. (Pattern: the Source Control panel's stage-many picker;
  the compile-refusal QuickPick already in `modbench.saveAndCompile`.)
- **Confirm**: `showWarningMessage(…, { modal: true })` naming the file, the number of
  records touched, and the total bytes dropped if any lossy item is checked. Nothing is
  written before this returns.
- **Write**: the repaired binary replaces the plugin file **in the mod folder**, through the
  same prepare/commit path Save & Compile uses (`PluginWriter`: journal markers,
  `PendingRecovery`, and the ADR-0008 timestamped `<plugin>.bak` beside the file, pruned to
  five) — no repair-specific backup file. MO2 recognises plugins by `.esp/.esm/.esl` suffix
  only, so the `.bak` is invisible to its plugin list. Header `HEDR.NumRecords`/`NextObjectID`
  untouched (#506); record and GRUP sizes recomputed by the engine, which is the only
  header-level edit it makes.
- **After**: the diagnosis re-runs on the written bytes. Success = Mutagen's deep parse
  succeeds and the subrecord inventory (#514) of the repaired plugin equals the original's
  *plus* the repair's own declared additions/removals — the repair is verified against its
  own preview, not just "parses now". Anything else rolls back from the `.bak` and reports.
  The endpoint then **reloads that plugin in the session itself** (it already holds the
  parsed result; the external-change watcher covers tracked plugins only) and republishes
  the plugin's Problems entries from the re-run, so they clear or shrink at once. A plugin
  that is untracked stays untracked; a tracked plugin is additionally *externally changed*
  from the parked ref's point of view and gets the standing external-change dialog
  ([medit-version-control.md](medit-version-control.md) § External change) — repair does
  not special-case it.
- **Eligibility** follows editability: only a plugin in the session's load order that is the
  file-level winner (resolution stack, #397); a file-level loser is refused naming the
  winner. **Immutable plugins** (vanilla/DLC masters) are never diagnosed for Kind B — they
  *are* the proof set the table is built from; a hit there is a test failure, not a
  diagnosis.
- **Row decoration**: a plugin carrying a Kind B diagnosis gets a plugin-row decoration
  through the existing session-derived `FileDecorationProvider` (ADR-0037's master /
  load-failure decorations, badge-priority rule in [plugins.md](plugins.md)) — no new
  mechanism. Later, in the Diagnostics & code actions milestone, the diagnosis is a
  lightbulb whose fix action is this gesture (#525).
- **Not offered**: a repair whose table row lacks a vanilla proof or a fixture; any change to
  a *Blocked upstream* defect; batch repair across plugins (one plugin per gesture — a
  modlist-wide "repair everything" is a script over the endpoint, if ever).

## Repair catalogue — what this surface is specced to fix

Every row: observed in the LitR survey, its canonical form proven by scanning every record
of the type in `Fallout4.esm` + all DLC ESMs, and a real fixture identified. A row without
all three does not ship. Game-generic by construction (the engine is format-level); the
*table entries* are per game, and #517's Skyrim survey extends them.

| # | Defect class | Fixture (real) | Vanilla proof | Operation | Loss |
|---|---|---|---|---|---|
| R1 | Object-template subrecords out of order: `OBTS` before `OBTF FULL` | `GaussRevolver.esp` (Lunar Arsenal) WEAP `03000860` | 1,031/1,031 templates `OBTF FULL OBTS` | **reorder** within one template item, `OBTE…STOP` | none |
| R2 | Fixed-size subrecord short: REGN `RDAT` 6 bytes | `LitR - TrueStorms.esp` REGN `001D2AF4`; also `Region Names on Save Files.esp`, `TrueStorms - RegionNamesOnSaveFile.esp` | 138/138 `RDAT` are 8 bytes; the 2 missing are the format's unused pad | **pad** to declared length with zero bytes | none |
| R3 | Fixed-count list short: RACE `NAME` ×31 / ×30 | `Lunar-UniqueCreatures.esp` RACE `03014174`, `0603637A` | 110/110 RACE carry exactly 32 | **pad** the list with empty entries to 32 | none |
| R4 | Counter disagrees with entries: `XWPG` = 1, `XWPN` × 2 | `SouthOfTheSea.esm` REFR `07431EDC` | 6/6 vanilla `XWPG` equal their `XWPN` count | **recount**: set the counter to the entry count | none |
| R5 | Perk entry-point: required `EPF3` missing on function 9 (Add Activate Choice) | `FTS_FastTravelSettlement.esp` PERK `050008AB` | 26/26 function-9 entries carry `EPF3` | **insert** `EPF3` = `0000` (no flags) | none — pre-selected, labelled *adds default* |
| R6 | Perk entry-point: parameter block present where the function takes none (function 6, Absolute Value, with `EPFT 1 EPFB EPFD`) | `Radfall.esp` PERK `0004C92C` | 2/2 function-6 entries have no `EPFT` | **drop** `EPFT`, `EPFB`, `EPFD` | **lossy** (junk the game ignores; xEdit hides it) |
| R7 | Perk entry-point: legacy parameter type (function 14 with `EPFT 2` float/AV where vanilla uses `EPFT 8` AVIF) | `SKI_PlasmaAutocannon.esp` PERK `040000EF` | 42/42 function-14 entries use `EPFT 8` | **none — diagnose only.** Converting an AV index to an `AVIF` FormKey is a semantic mapping, not a byte operation. | n/a |

The engine's operation set is therefore exactly: **reorder, pad (bytes or entries),
recount, insert-default, drop**. A future row that needs a sixth operation is a design
change to this spec, not a table addition.

Explicitly *not* in the catalogue — these are Kind A and route to **Blocked upstream**:

- MSWP differing `FNAM` (Mutagen #687 — the version gate is dead code).
- FormLinks inside `ScriptStructListProperty` (Mutagen #688 — master pruned on write; #520).
- Region "second same-type `RDAT`" — retracted; the real defect was R2.
- Anything model-identity (#513) or encoding-class (`-0.0`, float colours, zlib level).

## Requirements

1. **Mutagen-free engine.** The repair engine and every detector operate on raw bytes and
   reference no Mutagen type. Mutagen appears only in verification (does the result parse).
2. **Table-driven.** A repair is a table row: detector, operation, vanilla proof reference,
   fixture. No per-record-type code paths.
3. **Proof before ship.** Every row's canonical form is demonstrated by a scan of all vanilla
   records of that type, and the scan is kept (test or script) so the Skyrim survey can re-run
   it.
4. **Preview equals write.** The subrecord-level change shown in the preview is the exact
   change applied; post-write verification checks the result against the preview, not merely
   "it parses now".
5. **Lossless by default, lossy by consent.** Lossless items (including insert-default,
   labelled *adds default*) are pre-selected; any item that removes bytes is unselected,
   labelled with its byte cost, and named in the modal. Two deliberate acts — checking the
   item and confirming the modal that names it — are the consent; no per-record prompt.
6. **Never silent, never implicit.** No load path, Track, or Compile repairs anything.
   Repair is a named command with a modal.
7. **Backup and journal.** The ADR-0008 `.bak` and the journaled `PluginWriter` path, exactly
   as Save & Compile; a failed verification rolls back from the `.bak`.
8. **Ownership.** The plugin file may be changed by MO2/xEdit/the user between diagnosis and
   write; the engine re-reads and re-diagnoses at write time and refuses if the bytes moved.
9. **Kind A is untouchable.** A defect classed *Blocked upstream* is never offered an
   operation, regardless of how trivial the byte fix looks.
10. **Cost.** Kind B detection is the ~1 ms/plugin byte walk at session load (#569/#570); Kind A
    detection runs only after a failure. Repair's own cost is one walk + one write; no index
    rebuild unless the plugin is in the session, in which case the standing external-change
    path handles reload.
11. **Vocabulary.** `CONTEXT.md` defines **Diagnosis**, **Malformed plugin**, **Repair**
    (lossless / lossy); "fix", "clean", "sanitize" are avoided (xEdit's *clean* means ITM/UDR
    removal), and #381 is *Crash recovery*.

## Implementation Decisions

- **Placement**: `MEditService.Core` module beside `PluginWriter`/`TrackService` (logic lives
  in the service; the extension is a thin view — [CLAUDE.md](../../CLAUDE.md)). Exposed as
  one endpoint pair — *diagnose* (read-only, returns the diagnosis list with repairability)
  and *repair* (takes the selected diagnosis ids, returns the verification result). The
  extension command is a wrapper over the two; a CLI, if ever wanted, is a second thin front
  over the same module and is not part of this spec.
- **Engine origin**: the `RoundTripSurvey` walker (`Walk`, `Subrecords`, `Inflate`) is the
  reference implementation, promoted to Core once for #514, #519 and this — one walker.
- **Detectors are the diagnosis's** (#569); Repair adds only the operation column. The table
  is data (a static registry in Core, per game release), not configuration.
- **Compressed records**: inflate, operate, deflate with Mutagen's own level so the bytes
  match what Compile would later write; the size fields cascade (record → GRUPs) exactly as
  the survey's walker already computes them.
- **Preview rendering**: QuickPick item label = record identity; description = defect class +
  loss; detail = the subrecord diff line. One renderer shared with the diagnosis message text.

## Testing Decisions

- One fixture per catalogue row, cut down to the single offending record where the cutter
  (`CutDownPluginGenerator`) can, else the real plugin lifted into `TestData` (as #506 did).
- Per row: (a) diagnosis names the record/subrecord/class exactly; (b) repair preview text
  matches a literal; (c) repaired bytes deep-parse in Mutagen; (d) subrecord inventory of the
  result = original ± the row's declared change; (e) the repaired plugin then passes Track's
  round-trip gate (R1–R5) — or, for R6, is refused only for what the row said it would leave.
- Vanilla proof scans live as an env-gated test beside `RoundTripSurvey` (`MEDIT_SURVEY_MODS`
  pattern), so #517 re-runs them on Skyrim.
- Ownership: a test that mutates the plugin between diagnose and repair and asserts refusal.

## Out of Scope

- Fixing Kind A defects here (Mutagen #685–#688; our #520).
- Semantic conversions (R7 and its kin) — a future record-aware tool, if ever, is a different
  surface with Mutagen in the loop.
- Modlist-wide batch repair; scheduled or automatic repair.
- xEdit script generation or any Pascal.
- Changing what Track/Compile refuse (#513) or how the diagnosis is worded (#519).

## Resolved at grilling (2026-08-27)

- Lossy consent is the unchecked QuickPick item plus the modal naming the byte total — no
  per-record prompt.
- Backup is the standing ADR-0008 `.bak`; no repair-specific file.
- Kind B detection runs at session load and publishes to the Problems panel; the detectors
  are #569's, that surface is #570's. No standalone Diagnose command.
- Vocabulary landed in `CONTEXT.md`; #381 renamed *Crash recovery* in the glossary and the
  version-control spec (code keeps "crash repair").
- After a repair the endpoint reloads the plugin in the session and republishes its Problems
  entries; no watcher change.
- Eligibility = editability (load-order member, file-level winner); immutable plugins are
  never diagnosed.
- Row decoration reuses ADR-0037's provider; lightbulb fix action deferred to milestone
  "Diagnostics & code actions" (#525).
- Recorded as [ADR-0043](../adr/0043-malformed-plugins-are-repaired-by-a-byte-level-table-driven-engine.md).
