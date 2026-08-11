# CONT — Container

xEdit: wbDefinitionsFO4.pas:6256. mEdit: table `cont`, HasVmad=True.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `OBND` (Object Bounds, required) | *(absent)* | Same systemic drop as ALCH — see alch.md. | (b) bug, systemic. |
| `DEST` (Destructible incl. Resistances/Stages arrays) | `destructible` (struct, `subFields=[data]` only) | Same systemic drop as ALCH — see alch.md. | (b) bug, systemic. |
| `COCT` (explicit item count, `wbInteger`) | *(absent as its own column)* | Not surfaced separately — folded implicitly into the `items` array's length. | (a) deliberate — `COCT` is a derived/redundant count (`SetCountPath`-style companion to the `Items` list in Mutagen); not independently meaningful data. |

## Notes
- `DATA.Flags` (`AllowSoundsWhenAnimation`, `Respawns`, `ShowOwner`) → `flags` bitmask: all 3 present, correctly `isBitmask=True`.
- `major_flags` (`HasDistantLod`, `RandomAnimStart`, `Obstacle`, navmesh generation bits) → all present and correctly bitmask.
- `FTYP`/`NTRM`/`PRPS`/`SNAM`/`QNAM`/`TNAM`/`ONAM` all map cleanly to `forced_loc_ref_type`/`native_terminal`/`properties`/`open_sound`/`close_sound`/`take_all_sound`/`filter_list` with matching FormKey restrictions.
- `VMAD` correctly flagged `HasVmad=True` and handled via the dedicated `VmadCodec`, not expected as an ordinary column.
