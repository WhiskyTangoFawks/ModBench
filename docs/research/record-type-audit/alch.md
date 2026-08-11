# ALCH — Ingestible

xEdit: wbDefinitionsFO4.pas:5780. mEdit: table `alch`, HasVmad=False.

## Discrepancies
| xEdit field | mEdit column | Issue | Classification |
|---|---|---|---|
| `OBND` (Object Bounds, required) | *(absent)* | Missing entirely — no `object_bounds` column at all, not even as JSON. Root cause: Mutagen's `ObjectBounds.First`/`Second` are `P3Int16` (a triplet type) which `SchemaReflector.ClassifyLeaf`/`GetSubFieldInfo` don't map to any primitive, Loqui-struct, or list branch, so `BuildStructColumn` returns null (0 sub-fields) and the whole field is dropped silently instead of falling back to JSON. | (b) bug — see Notes, this is systemic across the whole codebase, not ALCH-specific. |
| `ENIT.Sound - Consume` (`wbFormIDCk('Sound - Consume', [SNDR, NULL])`) | `consume_sound` (formKey, `formKeyTypes=[sndr]`) | Shape/name fine — flattened out of the ENIT struct to a top-level column, matches Mutagen's own flat modeling of `Ingestible`. | (a) deliberate — Mutagen flattens ENIT's members onto the record directly rather than nesting a struct; mEdit reflects that. |
| `DEST` (Destructible: Header + `Resistances` array + `Stages` array) | `destructible` (struct, `subFields=[data]` only) | `Resistances` and `Stages` (both `ExtendedList<T>` nested inside the `Destructible` Loqui struct) are missing — not even collapsed to JSON. `GetSubFieldInfo` (used for struct sub-fields) has no `IsListType` branch (only `GetColumnInfo`, the top-level dispatch, checks for lists), so any list nested inside a struct is silently dropped. | (b) bug — contradicts ADR-0005's own stated rule ("`ExtendedList<T>` → JSON"); systemic, see Notes. |

## Notes
- ALCH's `ENIT.Flags` bitmask (`No Auto-Calc`, `Food Item`, `Medicine`, `Poison`) maps correctly to mEdit's `flags` enum/bitmask column — all 4 values present, `isBitmask=True`. Good.
- `major_flags` (`Medicine`, bit 29) matches xEdit's record-level flag and is correctly a bitmask.
- Two systemic gaps recur across this whole batch (see alch/book/cont/ingr/keym/misc): (1) `ObjectBounds` (`OBND`) is dropped entirely wherever it's a required field, due to an unmapped `P3Int16`/`P3Float` leaf type in `SchemaReflector`; (2) `Destructible.Resistances`/`Destructible.Stages` (both `ExtendedList<T>` nested one level inside a struct) are dropped entirely rather than becoming JSON, because `GetSubFieldInfo` never checks `IsListType`. Both look like oversights in `SchemaReflector.cs`, not intentional per ADR-0005 (which says arrays — including nested ones — should become JSON, not vanish).
