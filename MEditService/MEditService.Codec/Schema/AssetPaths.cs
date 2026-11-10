using System.Collections.Concurrent;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Assets;

namespace MEditService.Codec.Schema;

/// <summary>One file a document names: its path in the Data folder, and the member path that names it.</summary>
public readonly record struct AssetPath(string DataPath, string FieldPath);

/// <summary>Which files in the Data folder a document names, answered by the schema for its record type.</summary>
public static class AssetPaths
{
    public static List<AssetPath> Collect(Document document, IReadOnlyList<ColumnSpec> columns)
    {
        var root = document.Element;
        var named = new List<AssetPath>();
        foreach (var col in columns)
        {
            FormReferences.WalkLeaves(DocumentNodes.VariantFor(col.Field, root), DocumentNodes.At(root, col.PropertyName), col.Name,
                leaf => leaf.DataPathOf is not null,
                (leaf, path, value) =>
                {
                    if (leaf.DataPathOf is { } dataPathOf && FormReferences.ExtractString(value) is { Length: > 0 } given)
                        named.Add(new(dataPathOf(given), path));
                });
        }
        return named;
    }

    private static readonly ConcurrentDictionary<Type, Func<string, string>> DataPathsByLink = new();

    /// <summary>Mutagen's path in the Data folder of a path an asset link of type <paramref name="link"/> holds, the same
    /// function for each link of one asset type.</summary>
    internal static Func<string, string> DataPathOf(Type link) => DataPathsByLink.GetOrAdd(link, static type =>
    {
        var assetType = (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IAssetLinkGetter<>) ? type : null)
            ?? type.GetInterfaces().First(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IAssetLinkGetter<>));
        var getter = typeof(AssetLinkGetter<>).MakeGenericType(assetType.GetGenericArguments());
        return given => (Activator.CreateInstance(getter, given) as IAssetLinkGetter
            ?? throw new InvalidOperationException($"{getter} is no asset link.")).DataRelativePath.Path;
    });
}
