using System.Text.Json.Nodes;
using MEditService.Codec.Schema;

namespace MEditService.Commands.Edits;

/// <summary>Key order and duplicate-key refusal for keyed arrays, driven by field metadata at any
/// depth, so a top-level array and one nested inside a struct are answered once here.</summary>
internal static class KeyedArrays
{
    /// <summary>Rewrites every keyed array under <paramref name="node"/> into key order, in place.
    /// Answers the first duplicate key and the array holding it, or null when none collides.</summary>
    internal static (string Key, string Path)? Normalize(JsonNode? node, FieldMetadata meta, string path)
    {
        if (node is JsonObject obj && meta.Fields is { } fields)
        {
            foreach (var field in fields)
            {
                var member = DocumentNodes.VariantFor(field, obj);
                if (obj.TryGetPropertyValue(field.Name, out var child)
                    && Normalize(child, member, path.Length == 0 ? field.Name : $"{path}.{field.Name}") is { } dup)
                {
                    return dup;
                }
            }
            return null;
        }

        if (node is not JsonArray array || meta.ElementType is not { } elementMeta) return null;

        // Depth-first: an element's own keyed arrays are ordered before the array holding it is.
        for (var i = 0; i < array.Count; i++)
        {
            if (Normalize(array[i], elementMeta, $"{path}[{i}]") is { } dup) return dup;
        }

        return meta.KeyMembers is { } keyMembers ? SortByKey(array, keyMembers, elementMeta, path) : null;
    }

    private static (string, string)? SortByKey(JsonArray array, IReadOnlyList<string> keyMembers, FieldMetadata elementMeta, string path)
    {
        var keyed = new List<(ElementKey Key, JsonNode? Node)>(array.Count);
        foreach (var element in array) keyed.Add((ElementKey.Of(element, keyMembers, elementMeta), element));

        if (keyed.GroupBy(k => k.Key.Text, StringComparer.Ordinal).FirstOrDefault(g => g.Count() > 1) is { } dup)
            return (dup.Key, path);

        keyed.Sort((a, b) => a.Key.CompareTo(b.Key));
        array.Clear();
        foreach (var (_, node) in keyed) array.Add(node);
        return null;
    }
}
