# BOOK — Book

xEdit: wbDefinitionsFO4.pas:5977. mEdit: table `book`, HasVmad=True.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `OBND` (Object Bounds, required) | *(absent)* | Same systemic drop as ALCH — see alch.md. | (b) bug, systemic. |
| `DEST` (Destructible incl. Resistances/Stages arrays) | `destructible` (struct, `subFields=[data]` only) | Same systemic drop as ALCH — see alch.md. | (b) bug, systemic. |
| `DNAM.Teaches` (union: Actor Value / Spell / Perk / none, selected by flag bits) | *(absent — no `teaches`/`actor_value`/`spell`/`perk` column of any kind)* | Mutagen models this as `Book.Teaches : BookTeachTarget?`, an **abstract** Loqui type with concrete subtypes `BookActorValue`/`BookPerk`/`BookSpell`/`BookTeachesNothing`. `SchemaReflector.BuildSubSchema` reflects properties on the *abstract* getter interface (`IBookTeachTargetGetter`), which has none — the real properties live on the subtypes — so it returns 0 sub-fields and the whole `Teaches` field is dropped. This is arguably BOOK's single most important edit target (which skill/perk/spell a book grants) and it's entirely absent from the schema. | (b) bug — see Notes; same root-cause class as NOTE's missing Sound/Scene/Terminal/Program data (see note.md), likely recurs anywhere xEdit models a `wbUnion`. |
| `DNAM.Flags` (`Advance Actor Value` 0x01, `Can't be Taken` 0x02, `Add Spell` 0x04, `Add Perk` 0x10) | `flags` (enum bitmask, `enum=[CantBeTaken]` only) | Only 1 of 4 flag bits present. However this matches Mutagen's own `Book.Flag` enum, which *only* defines `CantBeTaken = 0x02` — the other 3 bits are internal implementation detail Mutagen uses (as `SkillFlag`/`SpellFlag`/`PerkFlag` constants) purely to decide which `BookTeachTarget` subtype to construct on read; they're redundant with which `Teaches` subtype is populated, so Mutagen deliberately doesn't expose them as user-facing flags. | (a) deliberate — sound modeling choice by Mutagen (flags redundant with the `Teaches` union), though it's moot right now since `Teaches` itself isn't exposed either (see row above). |
| `DNAM.Text Offset` struct (`X`, `Y`) | `text_offset_x`, `text_offset_y` (flat top-level int columns) | Not nested under a "text_offset" struct. | (a) deliberate — Mutagen itself flattens `DNAM`'s members (`Flags`, `Teaches`, `TextOffsetX`, `TextOffsetY`) directly onto `Book` rather than modeling `DNAM` as its own sub-object; mEdit's reflection just follows Mutagen's shape. |

## Notes
- `FIMD` (`Featured Item Message`) correctly restricted to `[mesg]` in both xEdit and Mutagen.
- `INAM` (`Inventory Art`) correctly restricted to `[stat]`.
- The missing `Teaches` field is a real functional gap: there is currently no way to see or edit what a Book teaches (skill/perk/spell) through mEdit's reflected schema. Combined with NOTE's missing Sound/Scene/Terminal/Program data (note.md), this strongly suggests `SchemaReflector` needs an explicit branch for abstract/polymorphic Loqui types (discriminated unions) — currently they silently vanish instead of falling back to JSON like arrays do.
