using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;

namespace MEditService.Core.Edits;

/// <summary>What the codec wrote back holds what the patch asked: every member the patch spelled
/// is present in the codec's spelling, unless a default the codec omits. A dropped member names the
/// failure (ADR-0032).</summary>
internal static class SilentSkipGuard
{
    // What came back holds what was asked: every member the patch spelled is present, in whatever
    // spelling the codec normalized it to, unless it was the default the codec omits. A member the
    // codec dropped names the failure.
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
                    if (FlagBits(wa, meta) is { } wb && FlagBits(pa, meta) is { } pb && wb == pb) return true;
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
                if (written is JsonValue writtenLeaf && LeafEquivalent(writtenLeaf, patchedLeaf, meta)) return true;
                dropped = path;
                return false;
            default:
                dropped = path;
                return false;
        }
    }

    // What the codec may change in a leaf it kept: the spelling, never the value. Flags compare as
    // bits, since the codec names a defined bit and spells an undefined one in hex.
    private static bool LeafEquivalent(JsonValue written, JsonValue patched, FieldMetadata? meta)
    {
        var w = JsonSerializer.SerializeToElement(written);
        var p = JsonSerializer.SerializeToElement(patched);
        if (w.ValueKind != p.ValueKind) return false;
        if (w.ValueKind != JsonValueKind.String) return DocumentNodes.SameValue(w, p);
        var (ws, ps) = (w.GetString()!, p.GetString()!);
        return meta?.Type switch
        {
            ByteSliceHex.HexApiType or "color" => string.Equals(ws.TrimStart('#'), ps.TrimStart('#'), StringComparison.OrdinalIgnoreCase)
                || string.Equals(StripHexPrefix(ws), StripHexPrefix(ps), StringComparison.OrdinalIgnoreCase),
            "formKey" => Mutagen.Bethesda.Plugins.FormKey.TryFactory(ws, out var wk) && Mutagen.Bethesda.Plugins.FormKey.TryFactory(ps, out var pk) && wk == pk,
            "vector" => Components(ws).SequenceEqual(Components(ps)),
            _ => string.Equals(ws, ps, StringComparison.Ordinal),
        };
    }

    private static string StripHexPrefix(string text) =>
        text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? text[2..] : text;

    private static IEnumerable<double> Components(string vector) =>
        vector.Split(',').Select(c => double.TryParse(c.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : double.NaN);

    // A flags array as the bits it names: a member by its declared bit, anything else as the
    // number it spells (decimal or hex), which is how the codec spells a bit no member names.
    private static long? FlagBits(JsonArray names, FieldMetadata? meta)
    {
        long bits = 0;
        foreach (var name in names)
        {
            var text = name?.ToString() ?? "";
            var member = meta?.EnumMembers.FirstOrDefault(m => m.Value == text);
            if (member?.BitValue is { } declared) bits |= long.Parse(declared, CultureInfo.InvariantCulture);
            else if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) && long.TryParse(text.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var hex)) bits |= hex;
            else if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number)) bits |= number;
            else return null;
        }
        return bits;
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
            JsonValue value => IsZero(value, meta),
            JsonArray array => array.Count == 0,
            JsonObject obj => obj.All(p => IsDefaultLike(p.Value, meta?.Fields?.FirstOrDefault(f => f.Name == p.Key) is { } f ? DocumentNodes.VariantFor(f, obj) : null)),
            _ => false,
        };
    }

    private static bool IsZero(JsonValue value, FieldMetadata? meta)
    {
        var element = JsonSerializer.SerializeToElement(value);
        return element.ValueKind switch
        {
            JsonValueKind.False => true,
            JsonValueKind.Number => element.GetDouble().CompareTo(0d) == 0,
            JsonValueKind.String => element.GetString() is { } s
                && (s.Length == 0 || (s == "Null" && meta?.Type == "formKey") || (s == "[]" && meta?.Type == ByteSliceHex.HexApiType)),
            _ => false,
        };
    }
}
