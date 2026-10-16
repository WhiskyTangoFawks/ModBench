using System.Diagnostics.CodeAnalysis;

namespace MEditService.Codec.Schema;

/// <summary>Two FormKey strings are one FormKey as Mutagen decides: by delimiter, hex case and plugin name
/// without case. Text Mutagen cannot parse is compared as written.</summary>
public sealed class FormKeyComparer : IEqualityComparer<string>
{
    public static readonly FormKeyComparer Instance = new();

    private FormKeyComparer()
    {
    }

    public bool Equals(string? x, string? y) =>
        x is null || y is null
            ? x is null && y is null
            : StringComparer.OrdinalIgnoreCase.Equals(CanonicalFormKey.OfOrAsWritten(x), CanonicalFormKey.OfOrAsWritten(y));

    public int GetHashCode([DisallowNull] string formKey) =>
        StringComparer.OrdinalIgnoreCase.GetHashCode(CanonicalFormKey.OfOrAsWritten(formKey));
}
