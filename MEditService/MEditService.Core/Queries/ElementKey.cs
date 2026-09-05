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

    /// <summary><paramref name="elementMeta"/> lets a flags member order by its bits, as xEdit's
    /// wbStructSK does, rather than by the names the document spells it with.</summary>
    internal static ElementKey Of(JsonElement element, IReadOnlyList<string> keyMembers, FieldMetadata? elementMeta = null) =>
        new([.. keyMembers.Select(path => ReadElement(element, path, MemberAt(elementMeta, path)))]);

    /// <summary>The write path holds a mutable JsonNode tree; one re-serialize reaches the same
    /// reader rather than a second copy of what a key reads as.</summary>
    internal static ElementKey Of(JsonNode? node, IReadOnlyList<string> keyMembers, FieldMetadata? elementMeta = null) =>
        Of(JsonSerializer.SerializeToElement(node), keyMembers, elementMeta);

    private static FieldMetadata? MemberAt(FieldMetadata? meta, string keyPath)
    {
        foreach (var hop in keyPath.Split('.'))
            meta = meta?.Fields?.FirstOrDefault(f => f.Name == hop);
        return meta;
    }

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

    private static (double?, string) ReadElement(JsonElement element, string keyPath, FieldMetadata? member)
    {
        var current = element;
        foreach (var hop in keyPath.Split('.'))
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(hop, out current))
                return DefaultOf(member);
        }

        return current.ValueKind switch
        {
            JsonValueKind.Number => (current.GetDouble(), current.GetDouble().ToString(CultureInfo.InvariantCulture)),
            JsonValueKind.String => (null, current.GetString()!),
            JsonValueKind.True or JsonValueKind.False => (null, current.GetRawText()),
            // A flags member is an array of names (ScenePhaseFragment.Flags keys a fragment); its
            // order is its bits', read off the members the schema declares.
            JsonValueKind.Array => (FlagBits(current, member), string.Join(", ", current.EnumerateArray().Select(e => e.ToString()))),
            _ => Absent,
        };
    }

    private static double? FlagBits(JsonElement names, FieldMetadata? member)
    {
        if (member == null) return null;
        double bits = 0;
        foreach (var name in names.EnumerateArray())
        {
            var bit = member.EnumMembers.FirstOrDefault(m => m.Value == name.GetString())?.BitValue;
            if (bit == null) return null;
            bits += double.Parse(bit, CultureInfo.InvariantCulture);
        }
        return bits;
    }

    // The codec omits a member equal to its default, so an absent key member reads as that
    // default: what the same element spelled out would read as.
    private static (double?, string) DefaultOf(FieldMetadata? member) => member?.Type switch
    {
        "int" or "float" => (0, "0"),
        "bool" => (null, "false"),
        "flags" => (0, ""),
        _ => Absent,
    };

    private static (double?, string) Absent => (null, "");
}
