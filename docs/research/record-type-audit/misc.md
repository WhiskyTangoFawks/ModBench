# MISC — Misc. Item

xEdit: wbDefinitionsFO4.pas:10294. mEdit: table `misc`, HasVmad=True.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `OBND` (Object Bounds, required) | *(absent)* | Same systemic drop as ALCH — see alch.md. | (b) bug, systemic. |
| `DEST` (Destructible incl. Resistances/Stages arrays) | `destructible` (struct, `subFields=[data]` only) | Same systemic drop as ALCH — see alch.md. | (b) bug, systemic. |
| record-level major flags (`Calc From Components` bit 11, `Pack-In Use Only` bit 13) | `major_flags` (`enum=[CalcFromComponents,PackInUseOnly]`, **`isBitmask=False`**) | This one is MISC-specific and is a real correctness bug, traced to its root cause: Mutagen's `MiscItem.MajorFlag` enum is defined as `CalcFromComponents = 11, PackInUseOnly = 13` — i.e. the raw **bit index** (11, 13), not the bit **mask** (`0x0000_0800`, `0x0000_2000`) that `Key.MajorFlag` correctly uses for the identical pair of flags (see keym.md). Since 11 and 13 aren't powers of two, `SchemaReflector.GetEnumMeta`'s power-of-two filter rejects both as "not atomic flags" and falls back to treating the whole enum as a single-choice (non-bitmask) value. Net effect: mEdit shows `major_flags` as a non-combinable enum, and if a raw value of `11` or `13` were ever written back as the literal flags integer it would corrupt the record's actual header flags (setting bits 0,1,3 or 0,2,3 instead of bit 11 or 13). | (b) bug — upstream in Mutagen (`Mutagen.Bethesda.Fallout4/Records/Major Records/MiscItem.cs`), not mEdit's own code, but mEdit's reflection-driven schema (ADR-0005) faithfully inherits it. Worth reporting upstream to Mutagen and/or adding a defensive check in `SchemaReflector`. |

## Notes
- `FIMD` (`Featured Item Message`) is unrestricted in xEdit's own MISC definition (`wbFormID(FIMD, 'Featured Item Message')`, no type list) but restricted to `[MESG]` in xEdit's BOOK definition. Mutagen consistently types `FeaturedItemMessage` as `FormLink<Message>` for *both* MISC and BOOK, so mEdit shows `formKeyTypes=[mesg]` for MISC too — stricter than xEdit's own (looser, arguably inconsistent) MISC definition. (a) deliberate — Mutagen's typing is plausibly more correct than xEdit's own inconsistency here, not a mEdit-introduced narrowing bug.
- `CVPA`/`CDIX` (`Components`, `Component Display Indices`) map to `components`/`component_display_indices`, both opaque JSON arrays — deliberate, consistent with every other array column.
