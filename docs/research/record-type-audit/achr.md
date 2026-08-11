# ACHR — Placed NPC

xEdit: wbDefinitionsFO4.pas:4574 (`wbRefRecord(ACHR, 'Placed NPC', ...)`). mEdit: table `achr`, HasVmad=True.

mEdit is reflection-generated from Mutagen's `PlacedNpc` object (`references/Mutagen/Mutagen.Bethesda.Fallout4/Records/Major Records/PlacedNpc.xml`), not from xEdit's pas definitions directly — field *names* throughout are Mutagen's snake_cased property names, not xEdit's labels; that's expected everywhere and not called out per row below.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `DATA` Position/Rotation | (none) | Not a record column at all | (a) deliberate — ADR-0023: placed-ref position is captured structurally into the `placement(pos_x, pos_y, pos_z)` side table during indexing and is explicitly "read-only by construction," never a reflected/editable field. **But** the side table only stores `pos_x/y/z` — rotation has no representation anywhere in mEdit (not the record schema, not the side table). Unclear, needs a human: was dropping rotation intentional, or an oversight in ADR-0023's side-table column list? |
| `XLOC` Lock Data | (none) | Missing entirely | (a) deliberate — verified in `PlacedNpc.xml`: Mutagen's `PlacedNpc` object doesn't model `XLOC` at all for ACHR (REFR's equivalent does exist, see refr.md). A Mutagen-level gap, not something mEdit's reflector could expose. |
| `XLTW` Lit Water (array) | (none) | Missing entirely | (a) deliberate — not modeled by Mutagen's `PlacedNpc` (verified in XML) |
| `XPWR` Reflected/Refracted By (array) | (none) | Missing entirely | (a) deliberate — not modeled by Mutagen's `PlacedNpc` (verified in XML) |
| `XRGB` Ragdoll Biped Rotation | (none) | Missing entirely, despite Mutagen modeling it as `P3Float? RagdollBipedRotation` | (b) bug — systemic issue A (raw `P3Float` struct unsupported by `SchemaReflector.ClassifyLeaf`/`PrimitiveMap`); see Notes. |
| `XHLT` Health % | (none) | Missing entirely, despite Mutagen modeling it as `Percent? Health` | (b) bug — systemic issue A (`Percent` is the same kind of unsupported raw value struct as `P3Float`) |
| Activate Parents → `XAPR` Activate Parent Refs (list of Reference+Delay) | `activate_parents` (struct, `subFields=[flags]` only) | The struct is present but its only interesting content — the list of parent refs + delays — is missing | (b) bug — systemic issue B (`GetSubFieldInfo`/`BuildSubSchema` has no branch for a `List`/`RefList` property nested inside a struct, unlike the top-level column path) |
| `XEMI` Emittance `[LIGH, REGN]`, `XMBR` MultiBound Reference (sigReferences), `XATR` Attach Ref (many types) | `emittance`, `multi_bound_reference` — `formKeyTypes=[]` | xEdit documents an explicit allow-list; mEdit shows none | (b) bug (minor) — systemic issue C: Mutagen declares these FormLinks against a shared marker interface (`IEmittance`, `IPlaced`) rather than a concrete `refName`, so `GetFormLinkValidTypes` can't resolve a target table. Field still editable, just no picker/validation hint. |

## Notes
- **VMAD**: handled by the dedicated `VmadCodec`, not expected as an ordinary column — consistent with `HasVmad=True`.
- **Systemic issue A** (raw value-struct types silently dropped): Mutagen's non-Loqui wrapper structs (`P3Float`, `P2Int16`, `P2Float`, `Percent`, `Color`, ...) aren't primitives, translated strings, enums, FormLinks, or Loqui interfaces (`IsLoquiInterface` requires a static `StaticRegistration` property, which these plain structs lack), so `GetColumnInfo`/`GetSubFieldInfo` return `null` for them with zero trace — no column, no placeholder, no log. When *every* field of a struct is one of these types, the whole struct vanishes too. This recurs across essentially every record type that carries a raw vector/percent/color field directly (confirmed independently in refr, cell, regn, lctn, lcrt, scol, wrld, ovis — see their respective files); it is the single biggest systemic finding in this batch.
- **Systemic issue B** (lists nested inside a struct silently dropped): confirmed in achr/refr's `ActivateParents.Parents`, `scol`'s `StaticPart.Placements`, and `ovis`'s `ObjectVisibilityManagerItem.ObjectBounds` — recurs 3+ times in this batch alone, contradicts ADR-0005's stated "nested arrays become JSON" behavior (here they become *nothing*, not JSON).
- **Systemic issue C** (interface-typed FormLinks lose `formKeyTypes`): lower severity than A/B — the field stays editable, it just can't hint valid target record types.
