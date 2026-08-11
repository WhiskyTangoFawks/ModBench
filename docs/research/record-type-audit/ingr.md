# INGR — Ingredient

xEdit: wbDefinitionsFO4.pas:9869. mEdit: table `ingr`, HasVmad=True.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `OBND` (Object Bounds, required) | *(absent)* | Same systemic drop as ALCH — see alch.md. | (b) bug, systemic. |
| `DEST` (Destructible incl. Resistances/Stages arrays) | `destructible` (struct, `subFields=[data]` only) | Same systemic drop as ALCH — see alch.md. | (b) bug, systemic. |

## Notes
- `ENIT` (Ingredient Value, Flags: `No auto-calculation`/`Food item`/`References Persist`) maps cleanly to `ingredient_value` + `flags` bitmask — all 3 flag values present, correctly bitmask.
- `ETYP`/`YNAM`/`ZNAM` map to `equip_type`/`pick_up_sound`/`put_down_sound` with matching FormKey restrictions (`equp`, `sndr`, `sndr`).
- `VMAD`, `EffectsReq` handled as expected (`HasVmad=True`; `effects` is an opaque JSON array, consistent with every other array column in the schema — deliberate per ADR-0005).
