using System.Text.Json;
using System.Text.Json.Nodes;

namespace MEditService.Codec.Schema;

/// <summary>What the codec wrote back holds what the patch asked: every member the patch spelled
/// is present in the codec's spelling, unless a default the codec omits. A dropped member names the
/// failure (ADR-0005).</summary>
internal static class SilentSkipGuard
{
    internal static bool Keeps(JsonNode? written, JsonNode? patched, FieldMetadata? meta, string path, out string dropped)
    {
        dropped = "";
        if (patched is null) return true;
        if (written is null)
        {
            if (IsDefaultLike(patched, meta)) return true;
            dropped = path;
            return false;
        }
        switch (patched)
        {
            case JsonObject po when written is JsonObject wo:
                foreach (var (name, pv) in po)
                {
                    var memberMeta = meta?.Fields?.FirstOrDefault(f => f.Name == name) is { } f ? DocumentNodes.VariantFor(f, po) : null;
                    var memberPath = path.Length == 0 ? name : $"{path}.{name}";
                    if (!wo.TryGetPropertyValue(name, out var wv))
                    {
                        if (pv is null || IsDefaultLike(pv, memberMeta)) continue;
                        dropped = memberPath;
                        return false;
                    }
                    if (!Keeps(wv, pv, memberMeta, memberPath, out dropped)) return false;
                }
                return true;
            case JsonArray pa when written is JsonArray wa:
                if (meta?.Type == "flags")
                {
                    if (LeafSpelling.SameFlags(wa, pa, meta)) return true;
                    dropped = path;
                    return false;
                }
                if (wa.Count != pa.Count)
                {
                    dropped = path;
                    return false;
                }
                for (var i = 0; i < pa.Count; i++)
                {
                    if (!Keeps(wa[i], pa[i], meta?.ElementType, $"{path}[{i}]", out dropped)) return false;
                }
                return true;
            case JsonValue patchedLeaf:
                if (written is JsonValue writtenLeaf && LeafSpelling.Same(writtenLeaf, patchedLeaf, meta)) return true;
                dropped = path;
                return false;
            default:
                dropped = path;
                return false;
        }
    }

    private static bool IsDefaultLike(JsonNode? node, FieldMetadata? meta)
    {
        if (node is null) return true;
        if (meta?.IsDiscriminator == true) return false;
        if (meta?.Default is { } declared)
        {
            return declared is string[] flags && node is JsonArray names
                ? names.Select(n => n?.ToString()).ToHashSet(StringComparer.Ordinal).SetEquals(flags)
                : DocumentNodes.SameValue(JsonSerializer.SerializeToElement(node), JsonSerializer.SerializeToElement(declared));
        }
        return node switch
        {
            JsonValue value => LeafSpelling.IsUnset(value, meta),
            JsonArray array => array.Count == 0,
            JsonObject obj => obj.All(p => IsDefaultLike(p.Value, meta?.Fields?.FirstOrDefault(f => f.Name == p.Key) is { } f ? DocumentNodes.VariantFor(f, obj) : null)),
            _ => false,
        };
    }
}
