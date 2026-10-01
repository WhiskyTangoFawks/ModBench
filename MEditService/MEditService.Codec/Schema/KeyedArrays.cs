using System.Text.Json.Nodes;

namespace MEditService.Codec.Schema;

/// <summary>A keyed array in a document, the path reaching it and each element's key.</summary>
public sealed record KeyedArray(JsonArray Elements, string Path, IReadOnlyList<ElementKey> Keys);

/// <summary>The keyed arrays of a document, found by field metadata at any depth.</summary>
public static class KeyedArrays
{
    /// <summary>Every keyed array under <paramref name="node"/>, an element's own before the array
    /// holding it.</summary>
    public static List<KeyedArray> Under(JsonNode? node, FieldMetadata meta)
    {
        var found = new List<KeyedArray>();
        Walk(node, meta, "", found);
        return found;
    }

    private static void Walk(JsonNode? node, FieldMetadata meta, string path, List<KeyedArray> found)
    {
        if (node is JsonObject obj && meta.Fields is { } fields)
        {
            foreach (var field in fields)
            {
                if (obj[field.Name] is { } child)
                    Walk(child, DocumentNodes.VariantFor(field, obj), path.Length == 0 ? field.Name : $"{path}.{field.Name}", found);
            }
            return;
        }
        if (node is not JsonArray array || meta.ElementType is not { } elementMeta) return;
        for (var i = 0; i < array.Count; i++) Walk(array[i], elementMeta, $"{path}[{i}]", found);
        if (meta.KeyMembers is { } keyMembers)
            found.Add(new KeyedArray(array, path, [.. array.Select(e => ElementKey.Of(e, keyMembers, elementMeta))]));
    }
}
