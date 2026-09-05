using System.Text.Json;
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

    /// <summary>The shape a member has under the object holding it: its own, or the variant the
    /// object's discriminator names when the member's type varies by leaf.</summary>
    internal static FieldMetadata VariantFor(FieldMetadata member, JsonElement? owner)
    {
        if (member.Variants is not { } variants || owner is not { ValueKind: JsonValueKind.Object } obj) return member;
        return obj.TryGetProperty(Schema.LoquiUnions.UnionTypeDiscriminator, out var leaf)
            && leaf.ValueKind == JsonValueKind.String
            && variants.TryGetValue(leaf.GetString()!, out var variant)
            ? variant
            : member;
    }
}
