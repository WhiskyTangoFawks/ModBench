using System.Text.Json;
using MEditService.Core.Queries;

namespace MEditService.Core.Schema;

// The facts a leaf carries whether it becomes a column or a sub-field. Convert is null when
// there is no generic applier: a form link, byte slice, color or vector gets its own writer in
// LeafWriters.RouteWriter.
internal sealed record LeafSpec(
    string ApiType,
    string DuckDbType,
    string[] ValidFormKeyTypes,
    IReadOnlyList<EnumMember> EnumMembers,
    Func<JsonElement, object?>? Convert,
    bool AllowsNull = false,
    string? ViewDefaultLiteral = null,
    // See FieldMetadata.Default.
    object? Default = null)
{
    /// <summary>A leaf that names no record type — every leaf but a form link.</summary>
    internal static readonly string[] NoFormKeyTypes = [];

    /// <summary>A leaf with no closed domain — every leaf but an enum.</summary>
    internal static readonly EnumMember[] NoEnumMembers = [];
}
