# TD-003 — ulong-backed [Flags] enums lose precision in JavaScript Number

## Problem

`Race.Flag` (and potentially other Mutagen FO4 enums) is backed by `ulong` and contains members with values ≥ 2^53:

- `LowPriorityPushable = 0x0020_0000_0000_0000` (= 2^53 — first integer not exactly representable as IEEE 754 double)
- `CannotUsePlayableItems = 0x0040_0000_0000_0000` (= 2^54)

`GetEnumMeta` serializes these as C# `long` values (backed by `Convert.ToInt64`). The backend returns them in `FieldMetadata.EnumBitValues` as JSON numbers. JavaScript `Number` is IEEE 754 double-precision, which can only represent integers exactly up to `Number.MAX_SAFE_INTEGER` (2^53 − 1 = 9007199254740991).

Values ≥ 2^53 silently lose precision at JSON deserialization. The JS bitwise operators then operate on corrupted values, and `onCommit` sends an imprecise integer back to the backend. The plugin file is written with a wrong flag value.

Note: Phase 12.1 already filters out non-power-of-two composite values, which happens to exclude many high-bit values. But any power-of-two value at bit 53+ still slips through because it IS a valid power-of-two.

## When it triggers

Editing any record field backed by a `ulong [Flags]` enum with a member at bit 53 or higher. For FO4, the known case is `Race.Flag` on Race records.

## Fix

Replace the `EnumBitValues: number[]` representation on the frontend with `BigInt` end-to-end:

1. **Backend**: serialize `EnumBitValues` as strings (`"18014398509481984"`) or use a JSON codec that emits `bigint`-compatible values.
2. **Generated API / types.ts**: change `enumBitValues` from `number[]` to `string[]` (deserialize as strings, convert to `BigInt` in FlagCell).
3. **FlagCell.tsx**: use `BigInt(meta.enumBitValues[i])` and `BigInt(num)` for all bitwise operations; convert the result back to `number` only when calling `onCommit` (the backend receives a JSON integer within `long` range, so this is safe as long as the committed value itself fits in 64 bits).

Alternatively, filter `GetEnumMeta` to skip members with `v > Number.MAX_SAFE_INTEGER` (9007199254740991). This is simpler but silently hides high-bit flags from the UI.

## Scope

- `MEditService.Core/Schema/SchemaReflector.cs` — `GetEnumMeta` serialization
- `medit-vscode/src/generated/api.ts` — regenerated after backend change
- `medit-vscode/webview/src/types.ts` — `enumBitValues` type
- `medit-vscode/webview/src/FlagCell.tsx` — BigInt arithmetic
