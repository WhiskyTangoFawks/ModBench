namespace MEditService.Core.Records;

// One row's worth of the global form_key -> (record type, EditorID) lookup (ADR-0031). Populated
// once per record at index time so resolution is O(1) instead of DuckDbRecordIndex.FindRecordType's
// per-table scan.
public readonly record struct RecordLookupEntry(string RecordType, string? EditorId);
