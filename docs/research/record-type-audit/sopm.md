# SOPM — Sound Output Model

xEdit: wbDefinitionsFO4.pas:9567. mEdit: table `sopm`, HasVmad=False.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `NAM1` "Data" struct's `Reverb Send %` member | `data` struct, subFields=`[flags, unknown]` (3rd xEdit member missing) | Mutagen's `SoundOutputData.ReverbSendPercent` is typed as `Percent` — a value struct, not a Loqui getter interface and not in `PrimitiveMap`. Same reflection gap as `ObjectBounds`'s `P3Int16` members: `GetSubFieldInfo` can't classify it, so it's silently dropped from the struct's subfields. | (b) bug — same systemic Percent/P3Int16-struct gap as `SOUN`/`ASPC`/`REVB` |
| `ATTN` "Dynamic Attenuation Values" | `dynamic_attentuation` (misspelled: missing a `u`) | Not an mEdit-introduced typo — Mutagen's own property is named `DynamicAttentuation` (same misspelling), and `SchemaReflector` mirrors the property name verbatim via `ToSnakeCase`. | (a) deliberate — reflects Mutagen's (also misspelled) upstream property name |

## Notes
- `MNAM` Type enum (`UsesHrtf`/`DefinedSpeakerOutput`), `VNAM` Static Attenuation, `ONAM` Output Values (→ `output_channels`, subFields=`[channel0, channel1, channel2]` matching xEdit's 3 named channel slots), and `ENAM` Effect Chain (→ `effect_chain`, formKeyTypes=[aech]) all match.
- `dynamic_attentuation`'s 12 subfields (`fade_in_distance_start/end`, `fade_out_distance_start/end`, `fade_in_curve_value1-4`, `fade_out_curve_value1-4`) correctly match xEdit's 4 top-level floats + two 4-member nested curve structs, flattened.
