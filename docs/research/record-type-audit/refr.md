# REFR — Placed Object

xEdit: wbDefinitionsFO4.pas:11425 (`wbRefRecord(REFR, 'Placed Object', ...)`). mEdit: table `refr`, HasVmad=True.

mEdit is reflection-generated from Mutagen's `PlacedObject` object (`references/Mutagen/Mutagen.Bethesda.Fallout4/Records/Major Records/PlacedObject.xml`). Field names are Mutagen's snake_cased property names, not xEdit's labels — expected throughout, not called out per row.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `DATA` Position/Rotation | (none) | Not a record column | (a) deliberate — ADR-0023: position lives in the `placement(pos_x, pos_y, pos_z)` side table, read-only by construction. Rotation has no representation anywhere (side table only stores position). Same open question as achr.md — unclear, needs a human. |
| `XMBO` Bound Half Extents | (none) | Missing entirely, despite Mutagen modeling it as `P3Float? BoundHalfExtents` | (b) bug — systemic issue A (raw `P3Float` struct unsupported; see achr.md Notes for the general mechanism) |
| `XPWR` Reflected/Refracted By (array) | (none) | Missing entirely | (a) deliberate — not modeled by Mutagen's `PlacedObject` (verified in XML) — Mutagen-level gap |
| `XORD` Linked Occlusion References | (none) | Missing entirely | (a) deliberate — Mutagen models `XORD` as a raw undecoded `ByteArray`, not a typed list; raw byte-array properties are (correctly) unexposable by the reflector regardless of the struct-drop bug |
| `XWCN`/`XWCU` Water Current Velocities → `WaterVelocity.Offset`/`Angle` (P3Float) | `water_velocity` (struct, `subFields=[versioning,unknown]` only) | Struct present but gutted — the two vectors that carry the actual current direction data are missing | (b) bug — systemic issue A |
| `XHLT` Health % | (none) | Missing entirely, despite Mutagen modeling it as `Percent? HealthPercent` | (b) bug — systemic issue A |
| Activate Parents → `XAPR` Activate Parent Refs (list) | `activate_parents` (struct, no parents list) | Same as achr.md | (b) bug — systemic issue B |
| `NAME` Base (sigBaseObjects), `XATR` Attach Ref, `XMBR` MultiBound Reference, `XCZR` Current Zone Reference | `base`, `attach_ref`, `multi_bound_reference`, `current_zone_reference` — all `formKeyTypes=[]` | xEdit documents explicit allow-lists; mEdit shows none | (b) bug (minor) — systemic issue C (interface-typed FormLinks: `IPlaceableObject`, `IPlaced`); see achr.md Notes |
| `XLOC` Lock Data | `lock` (struct, subFields=`[level,key,flags,unused]`) | — | No discrepancy — matches, unlike ACHR where Mutagen doesn't model `XLOC` at all |
| `XCVL`/`XCVR`/`XCZA` (raw water-current bytes) | (none) | Missing | (a) deliberate — Mutagen models these as raw `ByteArray`, not decoded fields |

## Notes
- **VMAD**: handled by the dedicated `VmadCodec`, consistent with `HasVmad=True`.
- Unlike ACHR, REFR's Mutagen model *does* carry `Lock`, `LitWater`, and most of the ACHR-only-missing fields — REFR is the more completely-modeled of the two placed-object types on the Mutagen side, so most of its gaps trace to the systemic reflector issues (A/B/C, detailed in achr.md) rather than to Mutagen not modeling the data at all.
- `Primitive`, `Portals`, `RoomPortal` (Bound Data), `OcclusionPlane`, `Linked Rooms`, `Alpha`, `TeleportDestination`, `Radio`, `Spline`, `ProjectedDecal`, `MapMarker`, `NavigationDoorLink` all matched mEdit's struct/array shape correctly — no issues found there.
