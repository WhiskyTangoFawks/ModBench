namespace MEditService.Index;

// One row's worth of the global form_key -> (record type, EditorID) lookup (ADR-0011), one per
// record so resolution is O(1).
public readonly record struct RecordLookupEntry(string RecordType, string? EditorId);
