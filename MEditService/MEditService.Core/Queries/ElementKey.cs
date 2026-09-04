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
/// </summary>
internal readonly record struct ElementKey(IReadOnlyList<(double? Number, string Text)> Segments)
{
    internal string Text => string.Join(" / ", Segments.Select(s => s.Text));

    internal static ElementKey Of(JsonElement element, IReadOnlyList<string> keyMembers) =>
        new([.. keyMembers.Select(path => ReadElement(element, path))]);

    /// <summary>The write path holds a mutable <see cref="JsonNode"/> tree rather than the
    /// <see cref="JsonElement"/> the compare grid aligns; it reaches the same reader through one
    /// re-serialize rather than a second copy of what a key reads as.</summary>
    internal static ElementKey Of(JsonNode? node, IReadOnlyList<string> keyMembers) =>
        Of(JsonSerializer.SerializeToElement(node), keyMembers);

    /// <summary>An element that is its own key — a pure-FormLink array's.</summary>
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
