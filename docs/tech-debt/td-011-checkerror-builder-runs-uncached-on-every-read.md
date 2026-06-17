# TD-011: `CheckErrorBuilder` Walks Every FormLink Leaf on Every Record Read, No Caching

**Severity:** Low
**Area:** `DuckDbRecordRepository.ReadDetail` / `CheckErrorBuilder.Build`
**Introduced:** Phase 10.3 (CheckError diagnostics)

## What's happening

[`ReadDetail`](../../MEditService/MEditService.Core/Records/DuckDbRecordRepository.cs#L276-L298)
calls `CheckErrorBuilder.Build(meta, value, getRecordType)` for every field of every record row read
— `GetRecord`, `GetRecordForPlugin`, and `GetAllOverrides` all go through it. `Build` walks the full
struct/array shape of the field and, for every FormLink leaf encountered, calls `getRecordType` (a
DuckDB index lookup via `FindRecordType`) — once per leaf, with no caching of repeated targets within
a row or across rows in the same query.

## Impact

For a field like an NPC's `keywords` (many FormLink elements) or `factions` (struct array with a
FormLink sub-field), reading one record does one DuckDB lookup per element. Listing/paging through
many records that share common targets (the same handful of keyword/faction FormKeys reused across
NPCs) re-resolves the same FormKey via a fresh lookup every time instead of caching resolved types for
the duration of the read.

No evidence yet that this is an active performance problem — FO4 sessions are read from an in-process
DuckDB index, and typical field/array sizes are modest — but it's added cost on a path
(`ReadDetail`) that previously did zero validation work, worth knowing if list views or large
sessions show read-latency regressions later.

## Fix Plan

If profiling shows this matters:

1. Cache `getRecordType` results for the duration of one read call (a `Dictionary<string, string?>`
   built per `ReadDetail`/`GetAllOverrides` call, since the same record can reference the same
   FormKey from multiple fields).
2. For `GetAllOverrides` specifically, consider sharing one cache across all overrides being read in
   the same call, since overrides of the same record often share targets.

Not worth doing speculatively — flag here so it's the first thing checked if read-path latency
becomes a complaint.

## Related

- `MEditService/MEditService.Core/Records/DuckDbRecordRepository.cs` — `ReadDetail`, `FindRecordType`
- `MEditService/MEditService.Core/Queries/CheckErrorBuilder.cs` — `Build`, `CheckScalar`
