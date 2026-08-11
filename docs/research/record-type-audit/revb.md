# REVB — Reverb Parameters

xEdit: wbDefinitionsFO4.pas:9671. mEdit: table `revb`, HasVmad=False.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `DATA` struct's `Diffusion %` and `Density %` members | *(none — struct flattened to 10 of xEdit's 12 members)* | Mutagen's `ReverbParameters.DiffusionPercent` and `DensityPercent` are both typed as `Percent` — a value struct, not a Loqui getter interface and not in `PrimitiveMap`/`IntegerTypes`. `SchemaReflector.GetSubFieldInfo`/`ClassifyLeaf` can't classify `Percent`, so both fields are silently dropped rather than surfaced as columns. | (b) bug — same systemic Percent/P3Int16-struct gap as `SOUN`/`ASPC`/`SOPM` (two instances in this one record) |

## Notes
Remaining 10 `DATA` members all match: `decay_milliseconds`, `hf_reference_hertz`, `room_filter`, `room_hf_filter`, `reflections`, `reverb_amp`, `decay_hf_ratio`, `reflect_delay_ms`, `reverb_delay_ms`, `unknown`. Top-level `ANAM` Reverb Class enum (`Default,ClassA,ClassB,ClassC,ClassD,ClassE`) matches `wbReverbClassEnum` exactly. `DATA` is a 1-level struct in xEdit but its members appear as flattened top-level columns in mEdit rather than nested under a `data` column — consistent with how Mutagen exposes `ReverbParameters`' own properties directly (no intermediate struct wrapper in the C# model), so this is a lower-layer (Mutagen) modeling choice mEdit inherits, not a shape bug in itself.
