using System.Text.Json;
using MEditService.Core.Queries;

namespace MEditService.Core.Schema;

// The neutral facts a leaf field carries, independent of whether it becomes a top-level
// column or a struct/array sub-field. Get reads the raw value from any instance; Convert
// turns a JSON token into the value to write — null means "no generic applier" (a form-link
// instead gets LeafWriters.ApplyFormLinkJson, identically for a top-level column and a sub-field).
internal sealed record LeafSpec(
    string ApiType,
    string DuckDbType,
    string[] ValidFormKeyTypes,
    IReadOnlyList<EnumMember> EnumMembers,
    Func<object, object?> Get,
    Func<JsonElement, object?>? Convert,
    bool AllowsNull = false,
    bool IsFlagsEnum = false,
    string? ViewDefaultLiteral = null)
{
    /// <summary>A leaf that names no record type — every leaf but a form link.</summary>
    internal static readonly string[] NoFormKeyTypes = [];

    /// <summary>A leaf with no closed domain — every leaf but an enum.</summary>
    internal static readonly EnumMember[] NoEnumMembers = [];
}
