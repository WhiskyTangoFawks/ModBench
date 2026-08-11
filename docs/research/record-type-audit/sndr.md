# SNDR — Sound Descriptor

xEdit: wbDefinitionsFO4.pas:9484. mEdit: table `sndr`, HasVmad=False.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `CNAM` Descriptor Type (enum: Standard/Compound/AutoWeapon) + `BNAM` Data (union: Standard-values struct \| Base Descriptor formkey, selected by `CNAM`) | *(none)* | Entirely missing from mEdit's dump. In Mutagen this is modeled as `SoundDescriptor.Data : IASoundDescriptorGetter?`, an abstract base interface with no data properties of its own — the real fields live on the runtime-selected concrete subtype (`SoundDescriptorStandardData` / `CompoundData` / `AutoweaponData`). `SchemaReflector.BuildStructColumn` walks the *static* declared properties of the base interface (`BuildSubSchema`), finds zero, and drops the column (`subFields.Count == 0 → return null`) rather than dispatching on the record's runtime subtype. | (b) bug — reflector doesn't handle Mutagen's discriminated-union property shape |

## Notes
- `wbConditions` on `SNDR` is handled by `Fallout4ConditionCodec` / `ConditionCodecRegistry` (registered generically per `SchemaReflector.cs:340-348`, not per-type) — correctly absent as an ordinary column, per the audit's Conditions carve-out.
- `wbSoundDescriptorSounds` (→ `ANAM` array of strings) maps to mEdit's `sound_files` (apiType=array) — matches.
- `descriptors` (`DNAM` rArray of `SNDR` formkeys) and `rates_of_fire` (`wbRArrayS` of structs) both collapse to opaque JSON-blob array columns — expected per ADR-0005 (`ExtendedList<T>` → JSON), not a bug.
- `ITMC` "Count" (`cpBenign`) is correctly absent — it's a derived array-length field, not independent data.
- `loop_and_rumble` (`LNAM` "Values" struct) is present with 4 subfields (`unknown, loop, sidechain, rumble_values`), matching xEdit's 4-member struct by count/order. The dump format doesn't expose nested-subfield `apiType`, so whether `loop` decodes as an enum (xEdit: None/Loop/EnvelopeFast/EnvelopeSlow) couldn't be verified here — flagging as worth a closer look but not calling it a discrepancy on this evidence.
