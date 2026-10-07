using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;

namespace MEditService.Commands.Edits;

/// <summary>Hops over an embedded child's place in its parent's document.</summary>
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

    internal static List<PathHop> HopsOf(IReadOnlyList<ChildStep> steps) =>
        [.. steps.SelectMany(step => step.Index is { } index ? [PathHop.Member(step.Slot), PathHop.At(index)] : new[] { PathHop.Member(step.Slot) })];
}
