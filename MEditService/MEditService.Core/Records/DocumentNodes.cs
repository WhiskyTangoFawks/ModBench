using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Core.Queries;

namespace MEditService.Core.Records;

/// <summary>Reads of the stored document by the schema's own paths. A node is handed out cloned,
/// so it outlives the <see cref="JsonDocument"/> it was parsed from.</summary>
internal static class DocumentNodes
{
    /// <summary>The member at a dotted path from the root, or null where the document omits it — which
    /// the codec does for a member equal to its default.</summary>
    internal static JsonElement? At(JsonElement root, string dottedPath)
    {
        var current = root;
        foreach (var hop in dottedPath.Split('.'))
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(hop, out current)) return null;
        }
        return current.ValueKind == JsonValueKind.Null ? null : current.Clone();
    }

    /// <summary>Two nodes spelling one value: numbers by magnitude, since the codec and a default's
    /// own spelling may differ in form (2 and 2.0), everything else by text.</summary>
    internal static bool SameValue(JsonElement a, JsonElement b) =>
        a.ValueKind == JsonValueKind.Number && b.ValueKind == JsonValueKind.Number
            ? a.GetDouble().CompareTo(b.GetDouble()) == 0
            : a.GetRawText() == b.GetRawText();

    // Two columns spelling one value: the codec's own text, since JsonElement has no Equals(); an
    // unordered array as a set; and against an absent side, what `defaultOf` says the codec omits.
    internal static bool SameNode(object? a, object? b, bool unordered, FieldMetadata? absentReadsAs)
    {
        if (a is JsonElement ja && b is JsonElement jb)
        {
            if (unordered && ja.ValueKind == JsonValueKind.Array && jb.ValueKind == JsonValueKind.Array)
                return ja.GetArrayLength() == jb.GetArrayLength()
                    && ja.EnumerateArray().Select(e => e.GetRawText()).Order()
                        .SequenceEqual(jb.EnumerateArray().Select(e => e.GetRawText()).Order());
            return ja.GetRawText() == jb.GetRawText();
        }
        if (a is null && b is null) return true;
        if (a is null || b is null)
            return absentReadsAs is { } meta && (a ?? b) is JsonElement present && IsOmitted(present, meta);
        return Equals(a, b);
    }

    // What the codec omits: the declared default where the metadata spells one, else a zero number,
    // false, an empty list or object, and a link to nothing.
    private static bool IsOmitted(JsonElement value, FieldMetadata meta) => meta.Default is { } declared
        ? SameValue(value, JsonSerializer.SerializeToElement(declared))
        : value.ValueKind switch
        {
            JsonValueKind.Number => value.GetRawText().Trim('-', '0', '.') is "" or "e0",
            JsonValueKind.False => true,
            JsonValueKind.String => meta.Type == "formKey" && value.GetString() == "Null",
            JsonValueKind.Array => value.GetArrayLength() == 0,
            JsonValueKind.Object => !value.EnumerateObject().Any(),
            _ => false,
        };

    /// <summary>The shape a member has under the object holding it: its own, or the variant the
    /// object's discriminator names when the member's type varies by leaf.</summary>
    internal static FieldMetadata VariantFor(FieldMetadata member, JsonElement? owner) =>
        owner is { ValueKind: JsonValueKind.Object } obj
            && obj.TryGetProperty(Schema.LoquiUnions.UnionTypeDiscriminator, out var leaf)
            && leaf.ValueKind == JsonValueKind.String
            ? Variant(member, leaf.GetString())
            : member;

    /// <summary>The same question over the write path's mutable tree.</summary>
    internal static FieldMetadata VariantFor(FieldMetadata member, JsonNode? owner) =>
        owner is JsonObject obj && obj[Schema.LoquiUnions.UnionTypeDiscriminator] is JsonValue leaf && leaf.TryGetValue<string>(out var name)
            ? Variant(member, name)
            : member;

    /// <summary>The shape a member has under a named union leaf; its own where no variant
    /// answers to that name.</summary>
    internal static FieldMetadata Variant(FieldMetadata member, string? leaf) =>
        leaf != null && member.Variants is { } variants && variants.TryGetValue(leaf, out var variant) ? variant : member;
}
