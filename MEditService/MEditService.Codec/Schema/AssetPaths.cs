using System.Text.Json;
using MEditService.Codec.Serialization;

namespace MEditService.Codec.Schema;

/// <summary>Mutagen's asset type: the folder in the Data folder where it keeps its files, with forward slashes, and the
/// extensions its files take.</summary>
public sealed record AssetType(string Folder, IReadOnlyList<string> Extensions);

/// <summary>One file a document names: its path in the Data folder, and the member path that names it.</summary>
public readonly record struct AssetPath(string DataPath, string FieldPath);

/// <summary>A path a member holds that its asset type cannot hold.</summary>
public readonly record struct AssetRefusal(string FieldPath, string Given, string Reason);

/// <summary>The files a document names, and each path it holds that no file can be named for.</summary>
public sealed record NamedFiles(IReadOnlyList<AssetPath> Files, IReadOnlyList<AssetRefusal> Refusals);

/// <summary>Which files in the Data folder a document names: the schema for its record type says which member holds a
/// path, and Mutagen's asset type says where in the Data folder it lies.</summary>
internal static class AssetPaths
{
    internal static NamedFiles Collect(JsonElement root, IReadOnlyList<ColumnSpec> columns)
    {
        var files = new List<AssetPath>();
        var refusals = new List<AssetRefusal>();
        foreach (var col in columns)
        {
            FormReferences.WalkLeaves(DocumentNodes.VariantFor(col.Field, root), DocumentNodes.At(root, col.PropertyName), col.Name,
                leaf => leaf.AssetLinkType is not null,
                (leaf, path, value) =>
                {
                    if (leaf.AssetLinkType is not { } linkType || FormReferences.ExtractString(value) is not { Length: > 0 } given) return;
                    var placed = AssetLinks.DataPathOf(linkType, given);
                    if (placed.DataPath is { } dataPath) files.Add(new(dataPath, path));
                    else refusals.Add(new(path, given, placed.Refusal ?? $"{given} is no path its asset type holds."));
                });
        }
        return new(files, refusals);
    }
}
