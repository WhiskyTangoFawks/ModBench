using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>Where an embedded child sits in its parent's document: the slot member and the position
/// of the element carrying its FormKey, at any depth of embedding.</summary>
internal static class EmbeddedChildPath
{
    /// <summary>The node the hops address, walked without metadata; null where the document has none.</summary>
    internal static JsonNode? Walk(JsonNode? root, IReadOnlyList<PathHop> hops)
    {
        var node = root;
        foreach (var hop in hops)
            node = hop.Kind == PathHop.MemberKind ? (node as JsonObject)?[hop.RequireName()] : (node as JsonArray)?[hop.RequireIndex()];
        return node;
    }

    internal static List<PathHop>? Find(JsonObject parent, string? parentTypeName, string formKey, GameRelease release) =>
        Find(parent, parentTypeName, formKey, ContainerSlots.For(release));

    private static List<PathHop>? Find(JsonObject parent, string? parentTypeName, string formKey, ContainerSlots slots)
    {
        foreach (var slot in slots.EmbeddedSlotsOf(parentTypeName))
        {
            if (!parent.TryGetPropertyValue(slot, out var value)) continue;
            switch (value)
            {
                case JsonObject single:
                    if (Found(single, formKey, [PathHop.Member(slot)], slots) is { } inSingle) return inSingle;
                    break;
                case JsonArray list:
                    for (var i = 0; i < list.Count; i++)
                    {
                        if (list[i] is JsonObject element
                            && Found(element, formKey, [PathHop.Member(slot), PathHop.At(i)], slots) is { } inList)
                        {
                            return inList;
                        }
                    }
                    break;
            }
        }
        return null;
    }

    // The element itself, or a child embedded further down (a worldspace's TopCell holds placed refs).
    // A slot's element names no type of its own, so every container's embedded slots are tried.
    private static List<PathHop>? Found(JsonObject element, string formKey, List<PathHop> hops, ContainerSlots slots)
    {
        if (element[RecordMembers.FormKey] is JsonValue key && key.TryGetValue<string>(out var text)
            && string.Equals(text, formKey, StringComparison.Ordinal))
        {
            return hops;
        }

        return Find(element, null, formKey, slots) is { } deeper ? [.. hops, .. deeper] : null;
    }
}
