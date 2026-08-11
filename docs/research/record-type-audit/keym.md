# KEYM — Key

xEdit: wbDefinitionsFO4.pas:9904. mEdit: table `keym`, HasVmad=True.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `OBND` (Object Bounds, required) | *(absent)* | Same systemic drop as ALCH — see alch.md. | (b) bug, systemic. |
| `DEST` (Destructible incl. Resistances/Stages arrays) | `destructible` (struct, `subFields=[data]` only) | Same systemic drop as ALCH — see alch.md. | (b) bug, systemic. |

## Notes
- `major_flags` (`Calc Value From Components` bit 11 = `0x0000_0800`, `Pack-In Use Only` bit 13 = `0x0000_2000`) is correct here — `Key.MajorFlag` in Mutagen uses proper bit-mask values and mEdit correctly shows `isBitmask=True`. Contrast with MISC's near-identical flag pair, which is broken upstream in Mutagen (see misc.md) — worth cross-referencing, since KEYM shows what the *correct* form looks like.
- `FULLReq` (required name) → `name`, `allowsNull=False`. Consistent.
- `PTRN`/`YNAM`/`ZNAM` → `preview_transform`/`pick_up_sound`/`put_down_sound`, all correctly FormKey-restricted (`trns`, `sndr`, `sndr`).
