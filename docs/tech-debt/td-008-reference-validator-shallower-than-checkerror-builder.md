# TD-008: `ReferenceValidator` Validates One Level Deep; `CheckErrorBuilder` Recurses Fully

**Severity:** Low
**Area:** `ReferenceValidator.Validate` / `CheckErrorBuilder.Collect`
**Introduced:** Phase 10.3 (reference validation at stage time, ADR-0020)

## What's happening

Two independent walkers classify the same formKey/array/struct shape, with different depth:

- [`CheckErrorBuilder.Collect`](../../MEditService/MEditService.Core/Queries/CheckErrorBuilder.cs#L19-L49)
  (read-side diagnostics) recurses over `FieldMetadata` without a depth limit: `formKey` →
  `struct.Fields` → recurse, `array.ElementType` → recurse. Struct-in-array-in-struct, or any other
  nesting Mutagen's schema can produce, is handled.
- [`ReferenceValidator.Validate`](../../MEditService/MEditService.Core/Edits/ReferenceValidator.cs#L10-L44)
  (write-side validation) only handles `col.ApiType == "formKey"` at the top, or `"array"` whose
  element is `"formKey"` or `"struct"` with one flat pass over `subField`s — it does not recurse into
  a sub-field that is itself a `struct` or `array`.

## Impact

For any record type whose schema nests a FormLink two levels deep inside an array (e.g. an array of
structs where one struct field is itself an array of FormLinks, or a struct field containing another
struct with a FormLink), `CheckErrorBuilder` would flag a dangling/type-mismatched reference on read,
but `ReferenceValidator` would silently let the same value through at `StageEdit` time — the
read-time/write-time validation gap ADR-0020 was written to close, reopened for any schema shape this
deep.

No FO4 record type currently reflects this deep — `SchemaReflector`'s struct/array handling caps at
one level of `SubFields`/`ElementType` for FormLink purposes today — so this is latent, not active.

## Fix Plan

Share one recursive walker. The deeper fix in [TD-009](td-009-triplicated-formlink-walkers.md)
(consolidating `FormRefPathBuilder`, `ReferenceValidator`, and `CheckErrorBuilder` onto one walk)
would resolve this automatically — `ReferenceValidator`'s per-leaf check becomes a callback passed to
the same recursive walk `CheckErrorBuilder` already implements correctly. Tracked separately because
TD-009 is a larger refactor; this doc exists to make sure the depth mismatch isn't lost if TD-009 is
deferred.

## Related

- [TD-009](td-009-triplicated-formlink-walkers.md) — the consolidation that would fix this
- `MEditService/MEditService.Core/Queries/CheckErrorBuilder.cs`
- `MEditService/MEditService.Core/Edits/ReferenceValidator.cs`
- ADR-0020 — reference validation at stage time
