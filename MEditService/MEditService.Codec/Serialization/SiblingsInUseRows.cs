namespace MEditService.Codec.Serialization;

/// <summary>Per (type, member): for each value of that enum member, the sibling members it leaves in use.</summary>
public sealed class SiblingsInUseRows : Dictionary<(string TypeName, string MemberName), IReadOnlyDictionary<string, IReadOnlyList<string>>>;
