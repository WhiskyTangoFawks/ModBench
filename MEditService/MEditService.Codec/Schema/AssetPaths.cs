using System.Text.Json;
using MEditService.Codec.Serialization;

namespace MEditService.Codec.Schema;

/// <summary>One file a document names: its path in the Data folder, and the member path that names it.</summary>
public readonly record struct AssetPath(string DataPath, string FieldPath);

/// <summary>A path a member holds that its asset type cannot hold.</summary>
public readonly record struct AssetRefusal(string FieldPath, string Reason);

/// <summary>The files a document names, and each path it holds that no file can be named for.</summary>
public sealed record NamedFiles(IReadOnlyList<AssetPath> Files, IReadOnlyList<AssetRefusal> Refusals);

/// <summary>Which files in the Data folder a document names: the schema for its record type says which member holds a
/// path, and Mutagen's asset type says where in the Data folder it lies.</summary>
public static class AssetPaths
{
    public static NamedFiles Collect(string text, IReadOnlyList<ColumnSpec> columns)
    {
        using var document = JsonDocument.Parse(text);
        var root = document.RootElement;
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
                    else refusals.Add(new(path, placed.Refusal ?? $"{given} is no path its asset type holds."));
                });
        }
        return new(files, refusals);
    }
}
