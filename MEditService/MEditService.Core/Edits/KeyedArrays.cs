using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Queries;

namespace MEditService.Core.Edits;

/// <summary>Key order and duplicate-key refusal for keyed arrays, driven by field metadata at any
/// depth, so a top-level array and one nested inside a struct are answered once here rather than
/// per applier.</summary>
internal static class KeyedArrays
{
    /// <summary>The payload with every keyed array in key order, or untouched with the duplicate key
    /// named. A field with no keyed array is returned unparsed.</summary>
    internal static JsonElement Normalize(JsonElement value, FieldMetadata meta, out string? duplicateKey)
    {
        duplicateKey = null;
        if (!Carries(meta)) return value;

        var root = JsonNode.Parse(value.GetRawText());
        duplicateKey = Rewrite(root, meta);
        return duplicateKey == null ? JsonSerializer.SerializeToElement(root) : value;
    }

    // Asked before the payload is reparsed, so an ordinary field pays nothing for a concept it does not use.
    private static bool Carries(FieldMetadata meta) =>
        meta.KeyMembers != null
        || (meta.ElementType != null && Carries(meta.ElementType))
        || (meta.Fields?.Any(Carries) ?? false);

    // Depth-first: an element's own keyed arrays are ordered before the array holding it is, so one
    // pass leaves the whole tree in key order however deeply the nesting runs.
    private static string? Rewrite(JsonNode? node, FieldMetadata meta)
    {
        if (node is JsonObject obj && meta.Fields is { } fields)
        {
            foreach (var field in fields)
            {
                if (obj.TryGetPropertyValue(field.Name, out var child) && Rewrite(child, field) is { } dup) return dup;
            }
            return null;
        }

        if (node is not JsonArray array || meta.ElementType is not { } elementMeta) return null;

        foreach (var element in array)
        {
            if (Rewrite(element, elementMeta) is { } dup) return dup;
        }

        return meta.KeyMembers is { } keyMembers ? SortByKey(array, keyMembers) : null;
    }

    private static string? SortByKey(JsonArray array, IReadOnlyList<string> keyMembers)
    {
        var keyed = new List<(ElementKey Key, JsonNode? Node)>(array.Count);
        foreach (var element in array) keyed.Add((ElementKey.Of(element, keyMembers), element));

        if (keyed.GroupBy(k => k.Key.Text, StringComparer.Ordinal).FirstOrDefault(g => g.Count() > 1) is { } dup)
            return dup.Key;

        keyed.Sort((a, b) => a.Key.CompareTo(b.Key));
        array.Clear();
        foreach (var (_, node) in keyed) array.Add(node);
        return null;
    }
}
