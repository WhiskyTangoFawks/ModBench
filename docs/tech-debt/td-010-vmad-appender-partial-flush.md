# TD-010 — VMAD appenders flush partial data on exception (no transaction boundary)

**Status:** Open  
**Source:** `/code-review` on phase-13.1-vmad-backend-index  
**Verification:** CONFIRMED — DuckDB.NET `DuckDBAppender.Dispose()` calls `duckdb_appender_close`, which unconditionally flushes buffered rows per the DuckDB C API spec.

---

## Problem

`DuckDbRecordRepository.IndexVmad` opens three `DuckDBAppender` instances in `using` blocks. DuckDB appenders buffer rows in memory and flush to the table when `Close()` or `Dispose()` is called. `Dispose()` always flushes — there is no "discard on error" path.

If `VmadIndexer.IndexRecord` throws an unhandled exception mid-enumeration, the `using` blocks dispose all three appenders during stack unwind, committing however many rows were accumulated before the throw. The vmad tables are left with a partial snapshot: records processed before the exception are present, records after are absent.

### Failure scenario

`IndexVmad` begins writing 1 000 records. An exception is thrown on record 500. All three appenders are disposed normally (via `using`), flushing records 1–499. VMAD tables now contain an incomplete snapshot. The exception propagates to `Index()`, which has already deleted the old VMAD data (via `DeleteVmadForPlugin` which runs just before `IndexVmad`). There is no automatic recovery — the partial data persists until the next successful `Index()` call.

### Relationship to td-008 / form_references

`form_references` is protected by a different mechanism: `DeleteFormReferencesForPlugin` runs *after* both loops succeed, so a failed index leaves old form-reference data intact. VMAD does not get this protection because the appender-flush-on-dispose pattern inherently commits whatever was buffered regardless of success.

---

## Why this is deferred

1. **DuckDB has no per-statement transactions in appender mode.** Wrapping appender flushes in a transaction is not directly supported; it would require switching from appender API to parameterised INSERT batches, which is significantly slower for bulk indexing.

2. **The `NotImplementedException` catch** added in phase 13.1 prevents the most likely mid-record throw (Mutagen Variable property parse error). The remaining risk is DuckDB write errors or unexpected Mutagen exceptions, which are rare.

3. **The partial-data window is short.** A second successful `Index()` call restores consistency. The service logs the exception; the caller (session startup or `ReindexPlugin`) can retry.

4. **Mitigated by the delete-after-loop ordering.** `DeleteVmadForPlugin` was moved to run just before `IndexVmad` (phase 13.1 code review fix). A failure in the *main record loop* (before `IndexVmad` starts) now leaves old VMAD data intact, which covers the more likely failure mode.

---

## Proposed fix (when prioritised)

Switch `IndexVmad` from appender API to batched parameterised inserts wrapped in a DuckDB transaction:

```csharp
using var tx = _connection.BeginTransaction();
// ... INSERT statements ...
tx.Commit();  // only commits if no exception; tx.Dispose() rolls back on exception
```

Trade-off: parameterised inserts are slower than appenders for large plugins. Profile before committing; the vmad tables are likely smaller than the main record tables where appenders are used.

---

## Scope

- `MEditService/MEditService.Core/Records/DuckDbRecordRepository.cs` — `IndexVmad`
- `MEditService/MEditService.Core/Records/VmadIndexer.cs` — all three `Append*` methods
