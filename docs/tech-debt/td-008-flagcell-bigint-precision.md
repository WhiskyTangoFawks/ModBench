# TD-008 — FlagCell BigInt precision and crash (code-review findings)

**Status:** Findings 1–4 fixed; Finding 5 deferred (latent)  
**Source:** `/code-review` on tech-debt td-002–td-007 cleanup batch  
**Verification:** All findings below were confirmed by independent verifier agents.

---

## Resolution (string-through end-to-end)

Findings 1–4 share one root: bitmask flag values travelled across the API as JSON **numbers**,
so combined values above 2^53 (real for FO4 `Race.Flag`: `LowPriorityPushable = 2^53`,
`CannotUsePlayableItems = 2^54`) lost low bits at `JSON.parse`/`Number()`. Note `td-008`'s
"Option B" was wrong — the bitmask **write** path used `JsonElement.GetInt64()`, which throws
on a string token, so the backend did *not* already accept strings.

Fix made bitmask values travel as **decimal strings** in both directions:

- **Read** (`DuckDbRecordRepository.ReadDetail`): bitmask column values serialized as decimal
  strings. Contract documented on `FieldValue` in `Queries/Models.cs`.
- **Write** (`SchemaReflector`): new `ReadBitmaskLong(JsonElement)` helper accepts a string *or*
  number token; used at both bitmask `Apply` sites.
- **Frontend** (`FlagCell.tsx`): `toBigInt()` parses string (full precision) or number, and
  returns `0n` for anything else — also closing Finding 3's `BigInt(NaN)` crash. `onCommit`
  emits a decimal string (Finding 1).
- **Fixtures** (Finding 2): the three `number[]` `enumBitValues` updated to `string[]`.

Findings 1 (write), 3 (NaN crash), and 4 (read) are resolved; Finding 2's type errors are gone.

---

## Finding 1 — Data corruption on flag toggle (`FlagCell.tsx:34`)

**Severity:** High — incorrect integer written to plugin file  
**Status:** CONFIRMED

### Code

```tsx
// FlagCell.tsx line 34
onChange={() => onCommit(Number(num ^ bits[i]))}
```

### What goes wrong

`num` and `bits[i]` are both `bigint`. `num ^ bits[i]` produces a `bigint` — correct. Then `Number(bigint)` converts to an IEEE 754 float64 before passing downstream.

IEEE 754 float64 has 53 bits of significand. Combined flag values that mix a high bit (≥2^53) with a lower bit whose position falls below the ULP of the high bit's range are **not exactly representable** and are rounded:

| Combined value | High bit | Low bit | Result of `Number()` | Bits lost |
|---|---|---|---|---|
| 2^53 + 2^0 = 9007199254740993 | 2^53 | 2^0 | 9007199254740992 | bit 0 |
| 2^54 + 2^0 = 18014398509481985 | 2^54 | 2^0 | 18014398509481984 | bit 0 |
| 2^54 + 2^1 = 18014398509481986 | 2^54 | 2^1 | 18014398509481984 | bit 1 |

General rule: for flags in `[2^n, 2^(n+1))`, ULP = 2^(n−52). Any lower flag whose bit position is below `n−52` is silently dropped.

### Concrete failure scenario

Race.Flag (Fallout 4) has `LowPriorityPushable` at bit 53 and `Playable` at bit 0. A record with both set has value `9007199254740993`. User toggles any third flag → `num ^ bits[i]` = bigint still containing both high bits → `Number(...)` rounds to `9007199254740992` → `onCommit(9007199254740992)` → PATCH body contains wrong integer → plugin file written with `Playable` unset.

### Downstream path

`onCommit` → `onEdit` prop in RecordPanel → `handleEdit` (RecordPanel ~line 638) → `JSON.stringify({ plugin, fields: { [fieldName]: value } })` → HTTP PATCH. No recovery step after `Number()`.

### Proposed fix

Pass the committed value as a string so precision survives JSON serialization. Two options:

**Option A** — change `onCommit` to accept `string` for flag fields, pass `String(num ^ bits[i])`, and let the backend parse as `long`:
```tsx
onChange={() => onCommit(String(num ^ bits[i]))}
```
Requires verifying the backend's PATCH handler accepts string-encoded integers for BIGINT columns.

**Option B** — if the backend already accepts strings (it accepts `FieldValue.value: unknown`), simply pass the string. No backend change needed.

---

## Finding 2 — Test fixtures use `number[]` against `string[]` type (`FlagCell.test.tsx:15,25`, `StructRowGroup.test.tsx:54`)

**Severity:** High — build-breaking TypeScript error, masked by current gate configuration  
**Status:** CONFIRMED

### What changed

`types.ts` line 11 was updated from `enumBitValues?: number[]` to `enumBitValues?: string[]` to avoid loss of precision in BigInt conversion. Three existing test fixtures were not updated:

```tsx
// FlagCell.test.tsx line 15
const meta: FieldMetadata = {
  ...
  enumBitValues: [1, 2, 4, 8],  // number[] — TYPE ERROR
  ...
};

// FlagCell.test.tsx line 25
const meta: FieldMetadata = {
  ...
  enumBitValues: [1, 4],  // number[] — TYPE ERROR
  ...
};

// StructRowGroup.test.tsx line 54
enumBitValues: [1, 2, 4],  // number[] — TYPE ERROR
```

### Why the gates don't catch it

- `npm run lint` — ESLint only, no type-aware checking for this assignment
- `npm run test:unit` — Vitest/esbuild, strips types without checking them; tests pass at runtime because `BigInt(1)` works whether input is `1` or `"1"`
- `npm run test:integration` — compiles `tsconfig.integration.json` (extension src only, not webview)
- **`npm run build`** — `tsc` via vite webview build DOES catch this, but `npm run build` is not in the gates script

### Proposed fix

Update the three fixtures to string literals:
```tsx
enumBitValues: ['1', '2', '4', '8']  // FlagCell.test.tsx line 15
enumBitValues: ['1', '4']             // FlagCell.test.tsx line 25
enumBitValues: ['1', '2', '4']        // StructRowGroup.test.tsx line 54
```

Also: consider adding `npm run build` to the gates script (or running `tsc --noEmit` in the webview directory) so TypeScript errors in webview source are caught by the standard validation pass.

---

## Finding 3 — `BigInt(NaN)` crash in FlagCell edit/view mode (`FlagCell.tsx:18`)

**Severity:** Medium — component throws unhandled TypeError  
**Status:** CONFIRMED

### Code

```tsx
// FlagCell.tsx line 18
const num = value == null ? 0n : BigInt(Math.trunc(Number(value)));
```

### What goes wrong

The `value == null` guard covers `null` and `undefined` only. If `value` is a non-numeric non-null value:
- `Number("abc")` → `NaN`
- `Math.trunc(NaN)` → `NaN`
- `BigInt(NaN)` → throws `TypeError: Cannot convert NaN to a BigInt`

`value` is typed as `unknown` (`FieldValue.value?: unknown` in both the generated API schema and `types.ts`). The backend currently sends numbers for bitmask fields, so this is not triggered in the happy path. It would trigger on: unexpected backend response shape, a schema migration that changes field type, a test fixture mistake, or a future game where a bitmask field serializes differently.

### Proposed fix

Add a type guard before the conversion:

```tsx
const num = (value == null || typeof value !== 'number')
  ? 0n
  : BigInt(Math.trunc(value));
```

This also removes the redundant `Number()` call since `value` is already narrowed to `number`. `Math.trunc` on a finite `number` cannot produce `NaN`, so `BigInt()` is safe.

---

## Finding 4 — Read-path precision loss for combined values >2^53 (`FlagCell.tsx:18`)

**Severity:** Low — acknowledged in code; root fix is architectural  
**Status:** CONFIRMED (same root as Finding 1, different path)

### What goes wrong

Same IEEE 754 issue as Finding 1, but on the read path. The backend sends combined flag values as JSON numbers. `JSON.parse` cannot represent values >2^53 exactly — `9007199254740993` becomes `9007199254740992` at parse time, before `FlagCell` is ever reached.

The inline code comment already acknowledges this:
> `// onCommit converts back to Number; precision loss only occurs when a combined value mixes bits above 2^53 with lower bits (tracked separately as a value-field issue).`

### Root fix required

The value must travel as a string from DuckDB → API JSON → frontend. This requires:
1. Backend: serialize BIGINT flag values as JSON strings in `FieldValue`
2. `api.ts`: `FieldValue.value` would need a discriminated type or the string parsed on receipt
3. Frontend: parse the string as BigInt directly without a `Number()` intermediate

This is a cross-layer change and out of scope for a hotfix. **Track separately.** Fix 3 above (type guard) partially mitigates by treating non-numbers as 0n instead of crashing, but does not recover the lost bits.

---

## Finding 5 — Latent: grandchild pending lookup uses disk-array index on pending array (`RecordPanel.tsx:513`)

**Severity:** Low — not currently triggerable  
**Status:** PLAUSIBLE (latent)

### Code

```tsx
// RecordPanel.tsx line 513 (grandchild case)
case 'grandchild': {
  const elem = Array.isArray(rawPending)
    ? (rawPending as unknown[])[context.parentFieldIndex]
    : undefined;
  const sub = (elem as Record<string, unknown> | undefined)?.[diff.fieldName];
  pendingValue = pendingIfChanged(sub, diff.values[col.plugin]);
  break;
}
```

### What goes wrong

`context.parentFieldIndex` is the index from `parseElementIndex(child.fieldName)` — the position of this element in the **disk array** as returned by the diff backend. `rawPending` is the **pending value** for the parent array field. If an element was inserted before `parentFieldIndex` in the pending array (shifting positions), `rawPending[parentFieldIndex]` reads the wrong struct element, showing wrong grandchild pending values.

### Why currently latent

`ArrayRowGroup.tsx` only renders add/remove buttons when `elemMeta?.isSortable` is true. Sortable arrays use value-equality matching in `extractPendingElementValue`, not index-based lookup. Non-sortable struct arrays currently support only in-place value edits (no insert/delete). The bug activates if non-sortable array insert/delete is ever added.

### Proposed fix (when the feature is added)

For non-sortable arrays, the pending representation should use the element index from `rawPending` as-is (since pending stores the modified element in-place). Verify at that time whether the index should be rebased or whether the pending structure should be keyed differently (e.g., by a stable element identifier rather than position).
