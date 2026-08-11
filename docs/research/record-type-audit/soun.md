# SOUN — Sound Marker

xEdit: wbDefinitionsFO4.pas:12037. mEdit: table `soun`, HasVmad=False.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `OBND` Object Bounds (struct: `First`/`Second`, each a `P3Int16` X/Y/Z triple) | *(none)* | Entirely missing. Mutagen's `ObjectBounds.First`/`Second` are typed as the raw value struct `P3Int16`, not a Loqui getter interface. `SchemaReflector.IsLoquiInterface` requires `type.IsInterface`, so `P3Int16` fails that check and also isn't in `PrimitiveMap`/`IntegerTypes` — `GetSubFieldInfo` returns null for both members, `BuildSubSchema(ObjectBounds)` comes back empty, and `BuildStructColumn` drops the whole `ObjectBounds` column (`subFields.Count == 0`). Confirmed schema-wide: no record in the full dump has an `object_bounds`/`obnd`-shaped column, though `wbOBND` appears 41 times in `wbDefinitionsFO4.pas`. | (b) bug — systemic; see report-back for cross-type recurrence |
| `REPT` Repeat struct (Min Time, Max Time, Stackable) | `repeat` struct, subFields=`[versioning, min_time, max_time, stackable]` | mEdit's struct carries an extra `versioning` member not in xEdit's field list. Mutagen's `SoundRepeat.Versioning` is a `VersioningBreaks` bookkeeping enum (tracks which optional trailing fields parsed, driven by xEdit's `wbStruct(..., nil, 2)` version-length argument) exposed as an ordinary public property, and the reflector has no special-case to filter internal Mutagen bookkeeping fields inside nested structs. | (a) deliberate — inherent byproduct of ADR-0005's reflect-everything-public approach |

## Notes
- `SDSC` → `sound_descriptor` (formKeyTypes=[sndr]) matches correctly.
- `wbOBND` gap here is one instance of a pattern that recurs across this batch (also `ASPC`, `REVB` x2, `SOPM`) — see report-back summary.
