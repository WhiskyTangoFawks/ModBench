using MEditService.Codec.Schema;

namespace MEditService.Index;

/// <summary>Value is the stored document's own node for this field, verbatim, or null when the
/// document omits the member (which the codec does for a member equal to its default).</summary>
public record FieldValue(FieldMetadata Metadata, object? Value, string? CheckError = null);
