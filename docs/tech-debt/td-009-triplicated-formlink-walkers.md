# TD-009: Three Independent Walkers Over the Same FormLink/Array/Struct Shape

**Severity:** Medium
**Area:** `FormRefPathBuilder.Walk` / `ReferenceValidator.Validate` / `CheckErrorBuilder.Collect`
**Introduced:** Phase 10.3 (reference validation, CheckError diagnostics, TD-001 fix — three features
landed together, each adding its own traversal)

## What's happening

Three call sites independently walk the same conceptual shape — a field that is a `formKey`, an
`array` of `formKey`, or an `array` of `struct` containing `formKey` sub-fields — each keyed on a
different schema type and doing different per-leaf work:

| Walker | Schema type | Per-leaf action | Depth |
|--------|-------------|------------------|-------|
| [`FormRefPathBuilder.Walk`](../../MEditService/MEditService.Core/Records/FormRefPathBuilder.cs#L10-L42) | `ColumnSpec` | invoke `RefVisitor(path, formKey)` for indexing | 1 level into arrays |
| [`ReferenceValidator.Validate`](../../MEditService/MEditService.Core/Edits/ReferenceValidator.cs#L10-L44) | `ColumnSpec` | classify null/not-in-session/type-mismatch | 1 level into arrays |
| [`CheckErrorBuilder.Collect`](../../MEditService/MEditService.Core/Queries/CheckErrorBuilder.cs#L19-L49) | `FieldMetadata` | build a diagnostic string | fully recursive |

A prior simplify pass already deduped the *leaf-level* helpers (`ExtractString`, `ForEachElement` —
now shared `internal static` methods on `FormRefPathBuilder`), but the higher-level "what counts as a
formKey leaf, how do struct/array nesting compose" traversal logic remains written three times.

The depth mismatch is real, not hypothetical-only: see [TD-008](td-008-reference-validator-shallower-than-checkerror-builder.md)
for the concrete case where `ReferenceValidator`'s shallower walk silently diverges from
`CheckErrorBuilder`'s recursive one.

## Impact

- **Lockstep maintenance burden.** Adding a new nesting case (e.g. array-of-array, or a new
  container type Mutagen exposes) requires updating three hand-written walkers correctly. They have
  already drifted once (TD-008).
- **No single source of truth** for "how do I find every FormLink leaf in a field, with its path."
  Three answers exist, two of them ColumnSpec-keyed and one FieldMetadata-keyed despite both schema
  types describing the same shape (`ColumnSpec.ToFieldMetadata()` already converts one to the other).
- A bug fixed in one walker (e.g. a missed nesting case) does not automatically apply to the others.

## Fix Plan

Converge on one generic walk, parameterized by a per-leaf callback, that all three call sites
consume:

1. Pick one schema type to walk — `FieldMetadata` is the natural choice since `ColumnSpec` already
   converts to it via `ToFieldMetadata()`, and `CheckErrorBuilder`'s walk is already the most general
   (handles arbitrary depth).
2. Define one walk signature, e.g. `Walk(FieldMetadata meta, object? value, string path, Action<FieldMetadata, object?, string> onFormKeyLeaf)`, generalizing `CheckErrorBuilder.Collect`.
3. Reimplement `FormRefPathBuilder.Walk`'s `RefVisitor` and `ReferenceValidator.Validate`'s
   classification as callbacks into this one walk; `CheckErrorBuilder.Build` becomes a thin wrapper
   that collects diagnostic strings instead of owning the traversal.
4. This also resolves TD-008 (the depth mismatch) as a side effect, since there is only one depth
   once there's only one walker.

## Decisions to make before implementing

1. **`ColumnSpec` vs `FieldMetadata` as the canonical walked type** — `FormRefPathBuilder` and
   `ReferenceValidator` currently walk `ColumnSpec` because they need `Apply`/write-time data;
   confirm `FieldMetadata` carries everything needed (or thread `ColumnSpec` through alongside).
2. **Callback shape** — a single `Action` per leaf is simplest, but `FormRefPathBuilder` needs the
   *target FormKey string*, `ReferenceValidator` needs to *classify and may produce zero or one
   error*, and `CheckErrorBuilder` needs to *produce zero or one diagnostic string*. The shared walk
   should pass enough context (path, raw value, `AllowsNull`, `ValidFormKeyTypes`) for all three
   without forcing them to re-derive it.

## Related

- [TD-008](td-008-reference-validator-shallower-than-checkerror-builder.md) — concrete symptom of this duplication
- [TD-010](td-010-fieldpath-grammar-parsed-independently.md) — same root cause, different symptom (path string parsing)
- `MEditService/MEditService.Core/Records/FormRefPathBuilder.cs`
- `MEditService/MEditService.Core/Edits/ReferenceValidator.cs`
- `MEditService/MEditService.Core/Queries/CheckErrorBuilder.cs`
