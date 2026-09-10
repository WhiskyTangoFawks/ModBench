using System.Text.Json.Nodes;
using MEditService.Core.Serialization;
using MEditService.Core.Source;

namespace MEditService.Core.Edits;

/// <summary>Where an embedded child sits in its parent's document: the slot member and the position
/// of the element carrying its FormKey, at any depth of embedding.</summary>
internal static class EmbeddedChildPath
{
    private const string FormKeyMember = "FormKey";

    /// <summary>The node the hops address, walked without metadata; null where the document has none.</summary>
    internal static JsonNode? Walk(JsonNode? root, IReadOnlyList<PathHop> hops)
    {
        var node = root;
        foreach (var hop in hops)
            node = hop.Kind == PathHop.MemberKind ? (node as JsonObject)?[hop.Name!] : (node as JsonArray)?[hop.Index!.Value];
        return node;
    }

    internal static List<PathHop>? Find(JsonObject parent, string parentTypeName, string formKey)
    {
        foreach (var slot in ContainerChildFields.EmbeddedSlots.Where(s => s.ParentType == parentTypeName).Select(s => s.Slot))
        {
            if (!parent.TryGetPropertyValue(slot, out var value)) continue;
            switch (value)
            {
                case JsonObject single:
                    if (Found(single, formKey, [PathHop.Member(slot)]) is { } inSingle) return inSingle;
                    break;
                case JsonArray list:
                    for (var i = 0; i < list.Count; i++)
                    {
                        if (list[i] is JsonObject element && Found(element, formKey, [PathHop.Member(slot), PathHop.At(i)]) is { } inList)
                            return inList;
                    }
                    break;
            }
        }
        return null;
    }

    // The element itself, or a child embedded further down (a worldspace's TopCell holds placed refs).
    // A single-object slot's element names no type of its own, so every embedding type is tried.
    private static List<PathHop>? Found(JsonObject element, string formKey, List<PathHop> hops)
    {
        if (element[FormKeyMember] is JsonValue key && key.TryGetValue<string>(out var text)
            && string.Equals(text, formKey, StringComparison.Ordinal))
        {
            return hops;
        }

        foreach (var type in ContainerChildFields.EmbeddedSlots.Select(s => s.ParentType).Distinct(StringComparer.Ordinal))
        {
            if (Find(element, type, formKey) is { } deeper) return [.. hops, .. deeper];
        }
        return null;
    }
}
