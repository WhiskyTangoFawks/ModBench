# NOTE — Note

xEdit: wbDefinitionsFO4.pas:12537. mEdit: table `note`, HasVmad=True.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `DNAM` (`Type`: Sound/Voice/Program/Terminal) | *(absent)* | No `type` column at all. | (b) bug — see below, tied to the same root cause as the `SNAM`/`PNAM` row. |
| `SNAM`/`PNAM` union (`wbUnion` on `Type`: Sound FormID, Scene FormID, Terminal FormID, or Program File string) | *(absent — no `sound`/`scene`/`terminal`/`program_file`/`data` column of any kind)* | Mutagen models NOTE via its `Holotape` class (`recordType="NOTE"`), where `Data : AHolotapeData` is an **abstract** Loqui type with concrete subtypes `HolotapeSound`/`HolotapeVoice`/`HolotapeProgram`/`HolotapeTerminal`, and there's no separate `Type` property at all — the type is implicit in which subtype `Data` holds. `SchemaReflector.BuildSubSchema`/`BuildStructColumn` reflects the abstract getter interface (`IAHolotapeDataGetter`), which has 0 own properties, so `Data` is dropped entirely — along with it, `Type`. **This means NOTE's entire payload — what the note/holotape actually contains (a sound, a voice scene, a terminal link, or a program filename) — is completely absent from mEdit's schema.** Only cosmetic fields (name, icons, model, sounds, weight/value) remain. | (b) bug — same root-cause class as BOOK's missing `Teaches` (book.md): abstract/polymorphic Loqui union types are silently dropped by `SchemaReflector` instead of falling back to JSON. This is the most severe finding in this batch — NOTE is functionally near-unusable for editing its actual content. |
| `OBND` (Object Bounds, not required for NOTE) | *(absent)* | Same systemic drop as ALCH — see alch.md. | (b) bug, systemic. |

## Notes
- NOTE has no `DEST` field in xEdit, so the Destructible-array gap doesn't apply here.
- Given both BOOK.Teaches and NOTE.Data/Type are dropped for the identical reason (abstract Loqui base type with 0 own properties), this pattern likely recurs anywhere Mutagen models an xEdit `wbUnion` as a polymorphic hierarchy — worth a codebase-wide grep for other abstract Loqui base classes used as record properties, well beyond this batch.
