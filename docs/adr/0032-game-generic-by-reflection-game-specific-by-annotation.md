---
status: accepted
---

# Reflection is the whole schema; per-game facts enter only as validated annotation tables

mEdit generalizes across Bethesda games (root `CLAUDE.md`), and its schema layer earns that
generality cheaply: `SchemaReflector` has **zero** per-game branches. It reflects over the
`Mutagen.Bethesda.{Category}` assembly's major-record getters and turns them into tables.

The per-game facts reflection cannot see — a member that is GRUP metadata rather than record data,
padding xEdit never renders, which Color fields carry an alpha byte, which parameter members a
condition function actually uses — enter only as `SchemaAnnotations`: one table per concern per
game, keyed by Mutagen type name and member name, overlaid on reflection and validated before the
game's schema is built, so an entry naming a type or member reflection did not find fails schema
generation and names the entry.

## Decision

**Everything a record carries is reflected. A fact about a game that reflection cannot read is an
annotation row, never a branch and never a strategy interface.**

Two consequences worth stating outright, because neither is obvious:

- **A structurally divergent Mutagen shape is not a reason for a strategy.** Conditions (CTDA) were
  the case that looked like one: Mutagen models the same on-disk concept with four different object
  graphs — a flat `Condition` in Oblivion/Fallout 3; `ConditionFloat`/`ConditionGlobal` over 425
  per-function `*ConditionData` subclasses in Skyrim; the same Float/Global split over a single
  generic `FunctionConditionData` in Fallout 4; a `ConditionDatas` container over
  `IConditionParameters` in Starfield. That divergence is *union shape*, and the reflector models
  unions directly: a Loqui base with concrete classes under it becomes a sparse union of every
  leaf's members plus a `concrete_type` discriminator, and a member whose shape disagrees across
  leaves becomes one field per shape. Fallout 4's `Condition` and `ConditionData` reflect through
  that mechanism with no condition-specific code at all.

- **A per-function or per-value fact is an annotation, not a branch.** Fallout 4 resolves a
  condition's parameter slots from `Condition.GetParameterTypes`, a static table keyed by function;
  the `Reference` member is read only under one `RunOnType` value. Both are per-game knowledge and
  both enter as one `SiblingsInUse` row each, read from Mutagen's own table rather than
  transcribed, and validated against the assembly in all three directions (the governing member
  exists, the values it is keyed by are that enum's members, the siblings it names are that type's
  members).

## Consequences

- Adding a game is additive in one place: a `SchemaAnnotations` table for it. There is no second
  place where a game's condition shape, or any other shape, is described.
- A fact reflection *can* read is never written down. An annotation table that duplicated the
  assembly would drift from it silently; validation exists so it cannot.
- A shape the walk reaches and no one has decided a presentation for is named and counted
  (`SchemaRefusals`), not silently dropped — the honest third outcome beside "reflected" and
  "annotated".
- `VmadCodec` remains the one Mutagen-edge codec (ADR-0030). Its subject is a byte-identical,
  same-named type family across Skyrim/FO4/Starfield, so it generalizes by a namespace swap; that
  is a property of VMAD's shape, not a general licence for a per-game codec.
