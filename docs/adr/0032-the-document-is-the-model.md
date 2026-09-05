---
status: accepted
---

# The document is the model: Mutagen owns the typing, xEdit owns the presentation

mEdit edits Bethesda plugins for three games it does not hard-code. Everything below follows from
three rules, and every seam in the editing stack is one of them applied.

## Decision

**1. The document is the model.** A record is a JSON document produced by reflecting over Mutagen's
own record types. There is no second model of a record anywhere — no parsed struct for a concern
that "deserves" one, no adapter tree, no neutral DTO the backend and the webview agree on beside the
document. A concern that looks special — a condition list, a virtual-machine adapter — is a
field, and the gestures a field kind already has are the gestures it gets.

**2. Mutagen owns the typing.** What a member *is* — its CLR type, its nullability, the closed
domain of its enum, the record types a link may point at, which concrete classes sit under a base —
is read off the pinned assembly, never transcribed. `SchemaReflector` has zero per-game branches.

**3. xEdit owns the presentation.** What a value *reads as* to a modder — the prose a collapsed row
shows, the gesture that edits a cell, which arrays sort and by what — is xEdit's answer, cited to
its own definitions ([ADR-0034](0034-xedit-is-the-ux-reference-for-the-record-editor.md),
[ADR-0019](0019-xedit-unified-tree-model-for-compare-grid.md)). Presentation never reaches back into
the model: it changes no edit value and no copy value.

### Corollaries

- **Lossless by construction, and the tree is the game's own shape.** The document carries every
  member the assembly declares, so a round trip loses nothing by construction rather than by a
  checked list ([ADR-0042](0042-plugin-is-the-source-of-truth-lossless-source.md)). Its nesting is
  the record's own: a condition list sits at whatever depth the record puts it
  (`Perk.Effects[i].Conditions[j].Conditions`), and no field is promoted to a top-level "section"
  for the editor's convenience.

- **The reflected schema is the only wire contract.** One `FieldMetadata` tree describes every
  field, and there is no second, concern-specific endpoint or payload shape beside it. A capability
  a field has — a keyed array's alignment, a union's discriminator, which siblings a value puts in
  use — is a property on that tree, so a new concern needs no new wire.

- **Widgets come from metadata alone, and the backend refusal is the one gate.** The webview picks
  a cell from `FieldMetadata` and names no game. It owns no reflected default and no per-type table
  of what a value may be; it posts what the user asked for, and an unrepresentable write is refused
  server-side, naming the field. One gate, on the side that holds the assembly — never a client-side
  guess that has to agree with it.

- **The document carries data plus the discriminator, and Modbench never adds to it.** The member
  naming which leaf of a union a value turned out to be is the codec's own `MutagenObjectType`, and
  the compare hands it over as the document spells it. Nothing else is invented: no computed field,
  no display string, no index, and every member keeps Mutagen's own name. A shape the walk reaches and no one has
  decided a presentation for is named and counted (`SchemaRefusals`) — the honest third outcome
  beside "reflected" and "annotated" — never silently dropped.

- **Per-game knowledge enters the reflector only as validated annotation tables.** The facts
  reflection cannot see — a member that is GRUP metadata rather than record data, padding xEdit
  never renders, which Color fields carry an alpha byte, which arrays are keyed and by what, which
  parameter members a condition function uses, a point the type walk must stop at — are
  `SchemaAnnotations` rows: one table per concern per game, keyed by Mutagen type and member name,
  overlaid on reflection and validated before the game's schema is built. An entry naming a type or
  member reflection did not find fails schema generation and names the entry. Adding a game is
  additive in one place. A fact reflection *can* read is never written down, because a table that
  duplicated the assembly would drift from it silently.

## Why conditions are reflected rather than coded

Conditions (CTDA) are the case that argues hardest for a hand-written codec. The argument is wrong
in a way worth recording, because the next concern will make it again.

Mutagen models the same on-disk concept with four different object graphs: a flat `Condition` in
Oblivion and Fallout 3; `ConditionFloat`/`ConditionGlobal` over 425 per-function `*ConditionData`
subclasses in Skyrim; the same Float/Global split over a single generic `FunctionConditionData` in
Fallout 4; a `ConditionDatas` container over `IConditionParameters` in Starfield. That divergence
reads as four shapes needing four strategies. It is not — it is **union shape**, and the reflector
models unions directly. A Loqui base with concrete classes under it becomes the sparse union of
every leaf's members plus its `MutagenObjectType` discriminator, and a member whose shape disagrees
across leaves stays one field whose metadata carries a `Variants` map, one shape per leaf
(`ComparisonValue`: a float under `ConditionFloat`, a GLOB link under `ConditionGlobal`). Fallout 4's `Condition`
and `ConditionData` reflect through that mechanism with no condition-specific code at all, and the
"Use Global" gesture falls out as an ordinary discriminator switch.

The residue — which parameter slots a function uses, and that Run On's reference target is live only
under one Run On value — is per-*value*, not per-shape, so it is two `SiblingsInUse` annotation
rows read from Mutagen's own `Condition.GetParameterTypes` rather than transcribed, and validated
against the assembly in all three directions (the governing member exists, the values keying it are
that enum's members, the siblings it names are that type's members).

A separate schema per leaf of a union is refused for the same reason: the discriminator already
distinguishes the leaves, and `Variants` describes only the members whose shape differs by leaf, so a
second axis would describe the same fact twice.

The virtual-machine adapter goes through that same door, keyed arrays and all. There is no
hand-written Mutagen-edge codec anywhere in the stack, and a structurally divergent Mutagen shape is
not a reason to build one.

## Scope honestly stated

Fallout 4 is the only game built and tested in this repo. Skyrim and Starfield are reasoned about
from their Mutagen definitions and are not verified; multi-game verification was descoped and is
not tracked. FO4-concrete paths in tests are a fixture choice, not a platform lock.
