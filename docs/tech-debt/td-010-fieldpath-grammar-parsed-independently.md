# TD-010: `fieldPath` Grammar (`name[idx].sub`) Constructed and Parsed Independently in Three Places

**Severity:** Low
**Area:** `FormRefPathBuilder.Walk` (constructs) / `EditOrchestrator.TopLevelFieldName` + `ParseArrayIndex` (parse)
**Introduced:** Phase 4 (field-path strings) + Phase 10.3 (`ParseArrayIndex` added for the TD-001 fix)

## What's happening

The informal path grammar `"name"`, `"name[idx]"`, `"name[idx].subfield"` is:

- **Constructed** in [`FormRefPathBuilder.Walk`](../../MEditService/MEditService.Core/Records/FormRefPathBuilder.cs#L10-L42)
  via string interpolation: `$"{col.Name}[{idx}]"`, `$"{col.Name}[{idx}].{subField.Name}"`.
- **Parsed** in [`EditOrchestrator.TopLevelFieldName`](../../MEditService/MEditService.Core/Edits/EditOrchestrator.cs#L238-L239)
  via `fieldPath.Split(['.', '['], 2)[0]`.
- **Parsed again, differently**, in [`EditOrchestrator.ParseArrayIndex`](../../MEditService/MEditService.Core/Edits/EditOrchestrator.cs#L241-L247)
  via manual `IndexOf('[')`/`IndexOf(']')` scanning + `int.TryParse`.

Three independent implementations of one grammar, with no shared parser or formatter, and no
compiler-enforced link between them.

## Impact

- A future change to the grammar (e.g. supporting nested arrays `"foo[1][2]"`, or escaping for field
  names that contain `.` or `[`) requires finding and updating all three sites by hand — there's no
  single definition that fails to compile if one site is missed.
- `TopLevelFieldName` and `ParseArrayIndex` already disagree slightly in technique (`Split` vs.
  `IndexOf` scanning) for parsing the same string — harmless today since both happen to agree on
  results, but a sign there's no owned contract.

## Fix Plan

Give the grammar one owner — a small `FieldPath` parsing/formatting type (e.g. a `readonly record
struct FieldPath(string Top, int? Index, string? SubField)` with `static FieldPath Parse(string)` and
`override string ToString()` reconstructing the same format), living next to
`FormRefPathBuilder` since that's the canonical constructor today. `TopLevelFieldName` and
`ParseArrayIndex` become `FieldPath.Parse(fieldPath).Top` / `.Index`.

Low priority — three call sites, all in code paths exercised by tests, low risk of drift causing an
active bug today. Worth doing opportunistically alongside TD-009 if that consolidation happens, since
both touch the same files.

## Related

- [TD-009](td-009-triplicated-formlink-walkers.md) — same files, complementary consolidation
- `MEditService/MEditService.Core/Records/FormRefPathBuilder.cs`
- `MEditService/MEditService.Core/Edits/EditOrchestrator.cs` — `TopLevelFieldName`, `ParseArrayIndex`
