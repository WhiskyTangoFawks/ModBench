using System.Text.Json;
using MEditService.Codec.Serialization;

namespace MEditService.Codec.Schema;

/// <summary>One file a document names: its path in the Data folder, and the member path that names it.</summary>
public readonly record struct AssetPath(string DataPath, string FieldPath);

/// <summary>Which files in the Data folder a document names: the schema for its record type says which member holds a
/// path, and Mutagen's asset type says where in the Data folder it lies.</summary>
public static class AssetPaths
{
    public static List<AssetPath> Collect(string text, IReadOnlyList<ColumnSpec> columns)
    {
        using var document = JsonDocument.Parse(text);
        var root = document.RootElement;
        var named = new List<AssetPath>();
        foreach (var col in columns)
        {
            FormReferences.WalkLeaves(DocumentNodes.VariantFor(col.Field, root), DocumentNodes.At(root, col.PropertyName), col.Name,
                leaf => leaf.IsAssetLink,
                (leaf, path, value) =>
                {
                    if (leaf.AssetLinkType is { } linkType && FormReferences.ExtractString(value) is { Length: > 0 } given)
                        named.Add(new(AssetLinks.DataPathOf(linkType, given), path));
                });
        }
        return named;
    }

    /// <summary>The path in the Data folder that <paramref name="given"/> names at the member <paramref name="fieldPath"/>
    /// (as <see cref="Collect"/> spells it), or null where that member is no path to a file.</summary>
    public static string? DataPathAt(IReadOnlyList<ColumnSpec> columns, string fieldPath, string given)
    {
        var hops = fieldPath.Split('.').Select(hop => hop.Split('[')[0]).ToList();
        var leaf = columns.FirstOrDefault(col => col.Name == hops[0])?.Field;
        foreach (var hop in hops.Skip(1)) leaf = MemberOf(ElementOf(leaf), hop);
        return leaf?.AssetLinkType is { } linkType ? AssetLinks.DataPathOf(linkType, given) : null;
    }

    private static FieldMetadata? ElementOf(FieldMetadata? owner) => owner?.ElementType ?? owner;

    private static FieldMetadata? MemberOf(FieldMetadata? owner, string name) =>
        owner?.Fields?.FirstOrDefault(member => member.Name == name)
        ?? owner?.Fields?.SelectMany(member => member.Variants?.Values ?? []).Select(variant => MemberOf(variant, name)).FirstOrDefault(found => found is not null);
}
