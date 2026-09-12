namespace MEditService.Core.Schema;

// What a FormKey lookup answers, in the kernel's own words (ADR-0005): the record type and
// EditorID, never the Index's own lookup entry — a caller holding one converts at the call.
public readonly record struct ResolvedFormKey(string RecordType, string? EditorId);
