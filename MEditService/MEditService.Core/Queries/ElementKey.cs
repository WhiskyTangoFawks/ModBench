using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MEditService.Core.Queries;

/// <summary>Identified by its key members (xEdit's wbStructSK sort key). A numeric member
/// compares by value so stage 10 sorts after 9; an absent member is the empty key, a real key a
/// freshly added element carries.</summary>
internal readonly record struct ElementKey(IReadOnlyList<(double? Number, string Text)> Segments)
{
    internal string Text => string.Join(" / ", Segments.Select(s => s.Text));

    internal static ElementKey Of(JsonElement element, IReadOnlyList<string> keyMembers) =>
        new([.. keyMembers.Select(path => ReadElement(element, path))]);

    /// <summary>The write path holds a mutable JsonNode tree; one re-serialize reaches the same
    /// reader rather than a second copy of what a key reads as.</summary>
    internal static ElementKey Of(JsonNode? node, IReadOnlyList<string> keyMembers) =>
        Of(JsonSerializer.SerializeToElement(node), keyMembers);

    internal static ElementKey OfValue(string value) => new([(null, value)]);

    internal int CompareTo(ElementKey other)
    {
        for (var i = 0; i < Segments.Count; i++)
        {
            var (mine, theirs) = (Segments[i], other.Segments[i]);
            var order = mine.Number is { } a && theirs.Number is { } b
                ? a.CompareTo(b)
                : string.CompareOrdinal(mine.Text, theirs.Text);
            if (order != 0) return order;
        }
        return 0;
    }

    private static (double?, string) ReadElement(JsonElement element, string keyPath)
    {
        var current = element;
        foreach (var hop in keyPath.Split('.'))
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(hop, out current))
                return Absent;
        }

        return current.ValueKind switch
        {
            JsonValueKind.Number => (current.GetDouble(), current.GetDouble().ToString(CultureInfo.InvariantCulture)),
            JsonValueKind.String => (null, current.GetString()!),
            JsonValueKind.True or JsonValueKind.False => (null, current.GetRawText()),
            _ => Absent,
        };
    }

    private static (double?, string) Absent => (null, "");
}
