using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Assets;

namespace MEditService.Codec.Schema;

/// <summary>One file a document names: its path in the Data folder, and the member path that names it.</summary>
public readonly record struct AssetPath(string DataPath, string FieldPath);

/// <summary>Which files in the Data folder a document names: Mutagen places each path the record's asset links hold, and
/// the schema for its record type says which member holds it.</summary>
public static class AssetPaths
{
    public static List<AssetPath> Collect(string text, IReadOnlyList<ColumnSpec> columns, GameRelease gameRelease, string recordType)
    {
        var placed = ((IAssetLinkContainerGetter)RecordTextCodec.Deserialize(text, gameRelease, recordType))
            .EnumerateAssetLinks(AssetLinkQuery.Listed)
            .ToLookup(link => link.GivenPath, link => link.DataRelativePath.Path, StringComparer.Ordinal);
        using var document = JsonDocument.Parse(text);
        var root = document.RootElement;
        var named = new List<AssetPath>();
        foreach (var col in columns)
        {
            FormReferences.WalkLeaves(DocumentNodes.VariantFor(col.Field, root), DocumentNodes.At(root, col.PropertyName), col.Name,
                leaf => leaf.IsAssetLink,
                (_, path, value) =>
                {
                    if (FormReferences.ExtractString(value) is not { Length: > 0 } given) return;
                    if (!placed.Contains(given)) throw new InvalidOperationException($"Mutagen lists no asset link that holds {given} at {path}.");
                    named.AddRange(placed[given].Distinct(StringComparer.Ordinal).Select(dataPath => new AssetPath(dataPath, path)));
                });
        }
        return named;
    }
}
