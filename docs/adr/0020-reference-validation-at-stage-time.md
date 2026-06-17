# FormLink references are validated at stage time, not at apply time

`StageEdit` rejects any submitted FormLink value that is null on a non-nullable field, doesn't resolve to a record in the current session, or resolves to the wrong record type. Validation happens before the change is staged, returning a structured 422 (`InvalidReferences`) listing each bad field, the submitted value, the reason, and the expected types. Invalid references are never written to pending state.

## Why this is the right choice

The backend is the single enforcement point for all callers, including Agents calling the HTTP API directly. The frontend's FormKeyPicker already filters by valid type as a UX optimization, but it doesn't constrain Agents or raw API calls — without backend validation, the only enforcement was `FormKey.TryFactory()` at apply time, which checks string format only, not existence or type.

Validating at stage time (rather than apply time) means an invalid reference never enters pending-change state. Rejecting at apply time would mean a user could see a "successfully staged" change that later fails to save, with no clear path to know which edit was the problem.

## Considered alternatives

**Warn but allow staging** — lets the user/Agent see the problem in the pending changes panel without blocking. Rejected: it allows the exact bad-reference state we're trying to prevent to enter the document, and "warn" findings are easy to miss between staging and saving.

**Validate only at apply time** (status quo) — simplest, no new logic. Rejected: poor error locality (the apply step would need to map back to which staged edit caused it), and an Agent gets no actionable feedback until the final apply.

**Validate on the frontend only** (FormKeyPicker filtering) — already exists as a UX layer, but doesn't protect against direct API calls or Agent-authored edits, which are first-class callers per ADR-0012/0013.

## Consequences

- `StageEdit` now needs read access to the session's full record index (to check existence and type) before staging — same data source `IRecordRepository` already serves queries from.
- A cross-session reference (pointing to a record not currently loaded) is impossible to create through the API. To reference a record, its plugin must be in the loaded session.
- `FieldMetadata` gains `AllowsNull`, derived from whether the underlying Mutagen type is `IFormLinkNullable<T>` vs `IFormLink<T>`. This also feeds the read-side `CheckError` annotation used to flag bad references in already-loaded plugins (which are accepted on load — only creation is blocked).
