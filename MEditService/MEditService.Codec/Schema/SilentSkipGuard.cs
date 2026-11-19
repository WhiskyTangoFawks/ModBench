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
                return KeepsEachElement(wa, pa, meta?.ElementType, path, out dropped);
            case JsonValue patchedLeaf:
                if (written is JsonValue writtenLeaf && LeafSpelling.Same(writtenLeaf, patchedLeaf, meta)) return true;
                dropped = path;
                return false;
            default:
                dropped = path;
                return false;
        }
    }

    // An array the format sorts is written back in its order, not the patch's (ADR-0030), so each element the patch
    // asked is kept by one written element, its own position's first.
    private static bool KeepsEachElement(JsonArray written, JsonArray patched, FieldMetadata? meta, string path, out string dropped)
    {
        dropped = "";
        var unmatched = Enumerable.Range(0, written.Count).ToList();
        for (var i = 0; i < patched.Count; i++)
        {
            var at = $"{path}[{i}]";
            var keptInPlace = Keeps(written[i], patched[i], meta, at, out dropped);
            var match = keptInPlace && unmatched.Contains(i)
                ? i
                : unmatched.FirstOrDefault(j => Keeps(written[j], patched[i], meta, at, out _), -1);
            if (match < 0) return false;
            unmatched.Remove(match);
        }
        return true;
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
