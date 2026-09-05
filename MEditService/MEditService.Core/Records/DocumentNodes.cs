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

    private static FieldMetadata Variant(FieldMetadata member, string? leaf) =>
        leaf != null && member.Variants is { } variants && variants.TryGetValue(leaf, out var variant) ? variant : member;
}
