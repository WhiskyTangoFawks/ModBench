# ASPC — Acoustic Space

xEdit: wbDefinitionsFO4.pas:7133. mEdit: table `aspc`, HasVmad=False.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `OBND` Object Bounds (struct: `First`/`Second`, each a `P3Int16` X/Y/Z triple) | *(none)* | Entirely missing — identical root cause to `SOUN`: `ObjectBounds`'s members are typed as the raw `P3Int16` value struct, which `SchemaReflector` can't classify (not a Loqui interface, not a mapped primitive), so `BuildSubSchema` returns empty and the whole `ObjectBounds` column is dropped. Confirmed schema-wide — no record type in the full mEdit dump has an object-bounds column, despite `wbOBND` appearing 41 times in `wbDefinitionsFO4.pas`. | (b) bug — systemic; see report-back for cross-type recurrence |

## Notes
All other fields match: `SNAM`→`looping_sound` [sndr], `RDAT`→`use_sound_from_region` [regn], `BNAM`→`environment_type` [revb], `XTRI`→`is_interior` (bool), `WNAM`→`weather_attenuation_db` (float).
