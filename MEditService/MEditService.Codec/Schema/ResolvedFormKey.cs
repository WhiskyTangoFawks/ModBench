namespace MEditService.Codec.Schema;

// What a FormKey lookup answers, in the kernel's own words (target-architecture.d2 medit_kernel):
// the record type and EditorID, never the Index's own lookup entry — a caller holding one converts
// at the call.
public readonly record struct ResolvedFormKey(string RecordType, string? EditorId);
