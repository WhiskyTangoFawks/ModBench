using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MEditService.Core.Queries;

/// <summary>
/// One element of a keyed array (<see cref="FieldMetadata.KeyMembers"/>), identified by the values
/// of its key members in the order the annotation lists them — xEdit's own <c>wbStructSK</c> sort
/// key. <see cref="Text"/> is the key as a person reads it: the label a compare-grid row carries and
/// the key a duplicate refusal names. <see cref="CompareTo"/> is the order the array is written back
/// in, comparing a numeric member by value so stage 10 sorts after stage 9 the way xEdit's own
/// integer sort key does.
///
/// <para>An absent or null key member reads as the empty key, and that is a real key rather than a
/// defect: a script with no name is representable, and it is exactly what a freshly added element
/// carries until the user names it (#710 — a new element names its discriminator and nothing else).
/// A second unnamed element added to the same array is then what the duplicate refusal catches.</para>
///
/// <para>Read from either JSON representation because the two sides of the concept hold different
/// ones — the compare grid aligns <see cref="JsonElement"/>s it never mutates, the write path sorts
/// a mutable <see cref="JsonNode"/> tree — while what a key <i>is</i> stays defined once, here.</para>
/// </summary>
internal readonly record struct ElementKey(IReadOnlyList<(double? Number, string Text)> Segments)
{
    internal string Text => string.Join(" / ", Segments.Select(s => s.Text));

    internal static ElementKey Of(JsonElement element, IReadOnlyList<string> keyMembers) =>
        new([.. keyMembers.Select(path => ReadElement(element, path))]);

    internal static ElementKey Of(JsonNode? node, IReadOnlyList<string> keyMembers) =>
        new([.. keyMembers.Select(path => ReadNode(node, path))]);

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

    private static (double?, string) ReadNode(JsonNode? node, string keyPath)
    {
        var current = node;
        foreach (var hop in keyPath.Split('.'))
        {
            if (current is not JsonObject obj || !obj.TryGetPropertyValue(hop, out current)) return Absent;
        }

        if (current is not JsonValue value) return Absent;
        return value.GetValueKind() == JsonValueKind.Number
            ? (value.GetValue<double>(), value.GetValue<double>().ToString(CultureInfo.InvariantCulture))
            : (null, value.ToString());
    }

    private static (double?, string) Absent => (null, "");
}
