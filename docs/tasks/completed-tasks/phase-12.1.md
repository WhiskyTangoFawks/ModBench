# Phase 12.1 — Flag Enum / Bitmask Support

**Status: Complete**

*Goal: fields backed by C# `[Flags]` enums (NPC flags, weapon flags, item flags, etc.) render as multi-select checkboxes in edit mode and as comma-separated active flag names in read mode, rather than a useless raw integer.*

---

## Backend

### `SchemaReflector`

- [x] In the enum-detection branch of `SchemaReflector` (where `ApiType = "enum"` is set), add a check for `typeof([Flags])` attribute on the C# enum type via `enumType.GetCustomAttribute<FlagsAttribute>() != null`
- [x] Add `bool IsBitmask` to `FieldMetadata` record in `Queries/Models.cs` — `false` by default; `true` for flag enums
- [x] Propagate `IsBitmask` through `ColumnSpec` and `FieldMetadataMapper` wherever `FieldMetadata` is constructed for enum columns
- [x] Run `npm run generate-api` — `isBitmask` appears in the generated TypeScript `FieldMetadata` type

---

## Extension / Webview

### `types.ts`

- [x] Add `isBitmask?: boolean` to the `FieldMetadata` interface (will also appear in generated `api.ts` after regeneration)

### `FlagCell` component (new file: `webview/src/FlagCell.tsx`)

- [x] Props: `{ value: unknown; meta: FieldMetadata; editMode: boolean; onCommit: (v: unknown) => void }`
- [x] Read mode: parse the stored integer value; iterate `meta.enumValues`; display comma-separated names of active flags (bit set). Show `—` if value is null/undefined.
- [x] Edit mode: render a checkbox per flag name from `meta.enumValues`; each checkbox reflects its bit in the current integer value; toggling a checkbox XORs that bit and calls `onCommit` with the new integer
- [x] Guard against `meta.enumValues` being empty

### `renderCell` dispatch (`RecordPanel.tsx`)

- [x] In `renderCell()`, before the existing `enum` path in `ScalarCell`, check `meta.isBitmask === true` → render `<FlagCell>` instead of `<ScalarCell>`

---

## Tests

### Backend

- [x] `SchemaReflector` emits `IsBitmask = true` for a known FO4 flag enum (e.g. `Npc.Flag`)
- [x] `SchemaReflector` emits `IsBitmask = false` for a regular (non-flags) enum
- [x] `SchemaReflector` emits `EnumBitValues` aligned with `EnumValues`; all values are positive powers of two
- [x] `SchemaReflector` treats `[Flags]` enums with only composite (non-power-of-two) values as plain enums (`MiscItem.MajorFlag`)

### Webview (`FlagCell.test.tsx`)

- [x] Read mode: value `0b0101` with `enumValues: ['A','B','C','D']` renders `"A, C"`
- [x] Read mode: null value renders `"—"`
- [x] Edit mode: renders one checkbox per flag; `A` and `C` checked, `B` and `D` unchecked
- [x] Edit mode: unchecking `A` calls `onCommit(0b0100)` (only bit 2 remains)
- [x] Edit mode: checking `B` calls `onCommit(0b0111)` (adds bit 1)
- [x] Sparse bit positions: uses `enumBitValues[i]`, not `1 << i`
- [x] `StructRowGroup` dispatches bitmask enum sub-fields to `FlagCell` (not `<select>`)
- [x] `FlagCell` returns null safely when `enumBitValues` is absent

---

## Post-implementation findings (code review)

- **TD-003**: `Race.Flag` has `ulong` members ≥ 2^53; JS `Number` loses precision for those bits. Fix: `BigInt` end-to-end or skip high-bit members. See `docs/tech-debt/td-003-ulong-flag-precision.md`.
- **TD-004**: Three silent `catch { return null; }` blocks in `SchemaReflector` extractors are confirmed to fire during real game loads but frequency is unknown. Investigate with `LogDebug` before suppressing further. See `docs/tech-debt/td-004-schema-reflector-silent-catches.md`.

---

## Proof

```
Backend:  Passed! — Failed: 0, Passed: 555, Skipped: 0, Total: 555
Frontend: Test Files 17 passed (17) — Tests 191 passed (191)
```
