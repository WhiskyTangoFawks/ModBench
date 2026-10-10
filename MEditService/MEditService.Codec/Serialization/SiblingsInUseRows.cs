using System.Collections.ObjectModel;

namespace MEditService.Codec.Serialization;

/// <summary>Per (type, member): for each value of that enum member, the sibling members it leaves in use.</summary>
public sealed class SiblingsInUseRows(IDictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>> rows)
    : ReadOnlyDictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>>(
        new Dictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>>(rows))
{
    internal static SiblingsInUseRows None { get; } = new(new Dictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>>());
}
