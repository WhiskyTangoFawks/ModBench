using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MEditService.Codec.Schema;

/// <summary>How the codec spells a leaf and what it may change in one it kept: hex prefixes, colour and
/// vector spellings, flag bits, the unset-link and empty-hex sentinels, and a leaf's minted default.</summary>
internal static class LeafSpelling
{
    private const string UnsetLink = "Null";
    private const string EmptyHex = "[]";

    /// <summary>Two leaves spelling one value under the leaf's type.</summary>
    internal static bool Same(JsonValue written, JsonValue patched, FieldMetadata? meta)
    {
        var w = JsonSerializer.SerializeToElement(written);
        var p = JsonSerializer.SerializeToElement(patched);
        if (w.ValueKind != p.ValueKind) return false;
        if (w.ValueKind != JsonValueKind.String) return DocumentNodes.SameValue(w, p);
        var (ws, ps) = (DocumentNodes.StringValueOf(w), DocumentNodes.StringValueOf(p));
        return meta?.Type switch
        {
            ByteSliceHex.HexApiType => string.Equals(WithoutPrefix(ws), WithoutPrefix(ps), StringComparison.OrdinalIgnoreCase),
            ColorReading.ApiType => string.Equals(
                ColorReading.Of(ws, meta.HoldsAlpha), ColorReading.Of(ps, meta.HoldsAlpha), StringComparison.OrdinalIgnoreCase),
            "formKey" => Mutagen.Bethesda.Plugins.FormKey.TryFactory(ws, out var wk) && Mutagen.Bethesda.Plugins.FormKey.TryFactory(ps, out var pk) && wk == pk,
            "vector" => Components(ws).SequenceEqual(Components(ps)),
            _ => string.Equals(ws, ps, StringComparison.Ordinal),
        };
    }

    /// <summary>Two flags arrays naming the same bits: the codec names a defined bit and spells an
    /// undefined one in hex.</summary>
    internal static bool SameFlags(JsonArray written, JsonArray patched, FieldMetadata? meta) =>
        BitsOf(written, meta) is { } writtenBits && BitsOf(patched, meta) is { } patchedBits && writtenBits == patchedBits;

    /// <summary>Whether the leaf holds what a leaf of its type is minted with: false, zero, the empty
    /// string, the unset link or the empty hex.</summary>
    internal static bool IsUnset(JsonValue value, FieldMetadata? meta)
    {
        var element = JsonSerializer.SerializeToElement(value);
        return element.ValueKind switch
        {
            JsonValueKind.False => true,
            JsonValueKind.Number => element.GetDouble().CompareTo(0d) == 0,
            JsonValueKind.String => element.GetString() is { } s
                && (s.Length == 0 || (s == UnsetLink && meta?.Type == "formKey") || (s == EmptyHex && meta?.Type == ByteSliceHex.HexApiType)),
            _ => false,
        };
    }

    /// <summary>What a new element of the shape is minted as. A struct names only its discriminator,
    /// the schema's first leaf, and the codec fills in the rest.</summary>
    internal static JsonNode? Minted(FieldMetadata meta) => meta.Type switch
    {
        "string" => "",
        "formKey" => UnsetLink,
        "int" or "float" => 0,
        "bool" => false,
        "flags" or "array" => new JsonArray(),
        "enum" => meta.EnumMembers.Count > 0 ? meta.EnumMembers[0].Value : "",
        ByteSliceHex.HexApiType => EmptyHex,
        "struct" => MintedStruct(meta),
        _ => "",
    };

    /// <summary>A colour holding no alpha as Mutagen's binary read spells it, so a value pasted back
    /// as its cell copies it writes the document a fresh read gives.</summary>
    internal static JsonNode? AsRead(JsonNode? value, FieldMetadata meta) =>
        DocumentNodes.Rewrite(value, meta, (node, shape) =>
            node is JsonValue leaf && shape.Type == ColorReading.ApiType && !shape.HoldsAlpha && leaf.TryGetValue<string>(out var text)
                ? JsonValue.Create(ColorReading.AsReadWithoutAlpha(text))
                : node);

    private static JsonObject MintedStruct(FieldMetadata meta)
    {
        var element = new JsonObject();
        foreach (var field in meta.Fields ?? [])
            if (field.IsDiscriminator && field.EnumMembers.Count > 0) element[field.Name] = field.EnumMembers[0].Value;
        return element;
    }

    private static string WithoutPrefix(string text) =>
        text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? text[2..] : text;

    private static IEnumerable<double> Components(string vector) =>
        vector.Split(',').Select(c => double.TryParse(c.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : double.NaN);

    private static long? BitsOf(JsonArray names, FieldMetadata? meta)
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
}
