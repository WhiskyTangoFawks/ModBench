
namespace MEditService.Codec.Schema;

// The facts a leaf carries whether it becomes a column or a sub-field.
public sealed record LeafSpec(
    string ApiType,
    string DuckDbType,
    string[] ValidFormKeyTypes,
    IReadOnlyList<EnumMember> EnumMembers,
    bool AllowsNull = false,
    string? ViewDefaultLiteral = null,
    // See FieldMetadata.Default.
    object? Default = null)
{
    /// <summary>A leaf that names no record type — every leaf but a form link.</summary>
    public static readonly string[] NoFormKeyTypes = [];

    /// <summary>A leaf with no closed domain — every leaf but an enum.</summary>
    public static readonly EnumMember[] NoEnumMembers = [];
}
