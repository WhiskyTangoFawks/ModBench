# TD-006: Change-Type Vocabulary Is an Open String Scattered Across Three Sites

**Severity:** Low
**Area:** `EditOrchestrator` / `DuckDbPendingChangeService` / `PendingChangeConstants`
**Introduced:** Phase 4 (field edits) + Phase 10 (create/delete change types)

## What's happening

A pending change's kind — `field_edit`, `create`, `delete` — is a bare `string` (`change_type`
column, `Upsert(..., string changeType)`). The closed set of valid values is defined and referenced
in three different ways:

- **`PendingChangeConstants`** ([PendingChangeConstants.cs](../../MEditService/MEditService.Core/Edits/PendingChangeConstants.cs))
  declares `CreateChangeType = "create"`, `DeleteChangeType = "delete"`,
  `FieldEditChangeType = "field_edit"` — but the class is `internal` and the constants are used
  inconsistently.
- **`EditOrchestrator`** uses the constant in some places and a **raw literal** in another:
  ```csharp
  changeType: PendingChangeConstants.CreateChangeType,   // line 122  ✓
  changeType: "field_edit",                              // line 139  ✗ hard-coded
  PendingChangeConstants.DeleteChangeType,               // line 204  ✓
  PendingChangeConstants.FieldEditChangeType,            // line 220  ✓
  ```
- **`DuckDbPendingChangeService`** embeds the values in SQL: the table default
  `change_type VARCHAR NOT NULL DEFAULT 'field_edit'` (line 54), the `Upsert` parameter default
  `string changeType = "field_edit"` (line 111), and the create-detection query
  `WHERE ... change_type = '{PendingChangeConstants.CreateChangeType}'` (line 514).

So `"field_edit"` exists as: a named constant, a hard-coded C# literal, a SQL column default, and a
C# parameter default — four spellings of one value, only one of them the constant.

## Impact

- **No compiler help.** The set of change kinds is open. A typo (`"field_eidt"`) compiles and
  inserts a row no branch matches; `PluginWriter`'s apply dispatch would silently skip it.
- **Locality lost.** "What are the change kinds?" has no single answer — it's spread across a
  constants class, an orchestrator literal, and SQL strings.
- Low blast radius today (small closed set, single backend consumer), which is why this is the
  lowest-severity of the five — but it's a latent correctness gap as more change kinds are added
  (e.g. `renumber`, already named in PendingChange's documented type set).

## Fix Plan

Close the vocabulary; give it one owner in `Edits/`.

1. **One closed type.** Either a C# `enum ChangeType { FieldEdit, Create, Delete }` with a single
   string-mapping helper, or keep string constants but make `PendingChangeConstants` (or a renamed
   `ChangeType`) the *only* source — no raw literals anywhere.
2. **Replace every literal** with the type/constant: `EditOrchestrator:139`, the SQL column default,
   and the `Upsert` parameter default all reference it.
3. **Persist deliberately.** If an `enum` is chosen, the DuckDB column stores its mapped string via
   the one helper, so on-disk values and C# values can't diverge (mirrors ADR-0005's enum→VARCHAR
   convention for record schemas).

## Decisions to make before implementing

1. **`enum` vs. centralized string constants.** An `enum` gives exhaustiveness checking but needs an
   explicit string mapping for the DuckDB `change_type` column. Constants need zero mapping but give
   no exhaustiveness. Given the SQL persistence, a small `enum` + `ToDbString`/`FromDbString` pair is
   probably the deeper fix.
2. **Make `PendingChangeConstants` non-`internal`?** If the type is referenced from the API project
   (e.g. for OpenAPI), visibility changes. Confirm callers.
3. **Include `renumber`?** CONTEXT.md / ADR-0017 reference a `renumber` change type. Decide whether
   to enumerate it now or when Renumber (Phase 10.x) lands.

## Related

- [PendingChangeConstants.cs](../../MEditService/MEditService.Core/Edits/PendingChangeConstants.cs)
- `MEditService/MEditService.Core/Edits/EditOrchestrator.cs` — lines 122, 139, 204, 220
- `MEditService/MEditService.Core/Edits/DuckDbPendingChangeService.cs` — lines 54, 111, 514
- ADR-0005 — enum→VARCHAR(name) mapping precedent
- ADR-0017 — pending change model (`change_type` column)
