# TD-003: Domain-Result → HTTP Mapping Duplicated Per Endpoint

**Severity:** Medium
**Area:** `ChangeEndpoints` (all change routes) / `StageEditResult` + `DeleteRecordsResult` + `RevertChangeResult`
**Introduced:** Phase 10 (result unions replaced thrown exceptions)

## What's happening

Each change endpoint pattern-matches a domain result union onto an HTTP status code inline. The map
from result variant to status **is** the API contract, but it is copied across handlers instead of
living in one place.

`StageEditResult` is switched **twice, near-identically**, by `PatchRecord`
([ChangeEndpoints.cs:25–39](../../MEditService/MEditService.Api/Endpoints/ChangeEndpoints.cs#L25-L39))
and `CopyRecordTo`
([ChangeEndpoints.cs:57–69](../../MEditService/MEditService.Api/Endpoints/ChangeEndpoints.cs#L57-L69)).
The two copies have already drifted:

| Variant | PatchRecord | CopyRecordTo |
|---------|-------------|--------------|
| `NoSession` | Problem 500 | Problem 500 |
| `PluginImmutable` | 409 | 409 |
| `BlockedByGroup` | 409 | 409 |
| `RecordNotFound` | 404 | 404 |
| `ReadOnlyFields` | 422, "...cannot be edited" | 422, "...read-only" *(diff wording)* |
| **`InvalidReferences`** | **422 `UnprocessableEntity(errors)`** | **— missing → falls to 500** |
| `Staged` | 200 | 200 |

`CopyRecordTo` has no `InvalidReferences` arm, so that variant falls through to
`_ => Results.Problem("Unexpected error.")` — a generic **500 instead of the structured 422**
mandated by ADR-0020. The OpenAPI contract drifts too: `PatchRecord` declares
`.Produces<IReadOnlyList<ReferenceValidationError>>(422)` (line 44); `CopyRecordTo` does not.

The shared variants `NoSession` and `PluginImmutable` are also **re-declared** on every result type
(`StageEditResult`, `DeleteRecordsResult`) and re-mapped in every switch.

## Impact

- **Latent bug, today:** a copy-to-override that fails reference validation returns 500 with
  `"Unexpected error."` instead of 422 with the structured error list. Agents calling the API
  directly (ADR-0012/0013) get no actionable feedback — the exact failure ADR-0020 set out to fix.
- **Silent drift:** status codes and prose diverge between handlers that should be identical.
- **No single test surface:** the contract can only be verified route-by-route through HTTP.
- **Every new variant is N edits:** add a `StageEditResult` case and you must remember to handle it
  in both switches with the right status — the compiler's exhaustiveness help is defeated by the
  `_ =>` catch-all.

## Fix Plan

One translation adapter from domain result to `IResult`, plus shared error variants hoisted so they
map once.

1. **Hoist shared variants.** Factor `NoSession` and `PluginImmutable` into a common base (or a
   small shared `EditError` result) so they exist and map in exactly one spot.
2. **One translator per result family.** A static `ToHttpResult(StageEditResult)` /
   `ToHttpResult(DeleteRecordsResult)` owns the variant→status map. Endpoints call it:

   ```csharp
   var result = orchestrator.StageEdit(...);
   return result.ToHttpResult();   // PatchRecord and CopyRecordTo both
   ```
3. **Drop the `_ =>` catch-all** where the union is sealed, so a new variant becomes a compile
   warning/error rather than a silent 500.
4. **Fix the immediate bug** as the regression test: `CopyRecordTo` with an invalid reference must
   return 422 + `ReferenceValidationError[]`.

## Decisions to make before implementing

1. **Translator location.** An extension method in `MEditService.Api/Endpoints/` (keeps HTTP
   knowledge in the API project), vs. results carrying their own status (couples Core to HTTP —
   reject; status is an API concern).
2. **Shared base vs. shared sub-result.** A common base record across result families is minimal
   but mixes concerns; a dedicated `EditError` value that both families embed is cleaner but a
   bigger refactor. Decide during grilling.
3. **Problem detail wording** is currently per-endpoint ("cannot be edited" vs "read-only"). Decide
   whether to standardize or keep per-route messages (the translator can take a message map).

## Related

- [ChangeEndpoints.cs:25–69](../../MEditService/MEditService.Api/Endpoints/ChangeEndpoints.cs#L25-L69) — the two `StageEditResult` switches
- `MEditService/MEditService.Core/Edits/StageEditResult.cs` — 7 variants incl. `InvalidReferences`
- `MEditService/MEditService.Core/Edits/DeleteRecordsResult.cs`, `RevertChangeResult.cs`
- ADR-0020 — reference validation returns structured 422 at stage time
- ADR-0012 / ADR-0013 — Agents are first-class API callers; they depend on this contract
