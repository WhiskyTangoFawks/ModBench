using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MEditService.Codec.Schema;

/// <summary>Identified by its key members (xEdit's wbStructSK sort key). A numeric member
/// compares by value so stage 10 sorts after 9; an absent member is the empty key, a real key a
/// freshly added element carries.</summary>
public readonly record struct ElementKey(IReadOnlyList<(double? Number, string Text)> Segments)
{
    // After every load-order FormID: a FormKey of a plugin the game does not load.
    private const double Unloaded = 1L << 32;

    public string Text => string.Join(" / ", Segments.Select(s => s.Text));

    /// <summary>As xEdit's wbStructSK orders them: a flags member by its bits, read off
    /// <paramref name="elementMeta"/>, and a FormKey by its <paramref name="loadOrderFormIds"/>.</summary>
    public static ElementKey Of(
        JsonElement element, IReadOnlyList<string> keyMembers, FieldMetadata? elementMeta = null,
        Func<string, uint?>? loadOrderFormIds = null) =>
        new([.. keyMembers.SelectMany(path => ReadElement(element, path, MemberAt(elementMeta, path), loadOrderFormIds))]);

    /// <summary>The write path holds a mutable JsonNode tree; one re-serialize reaches the same
    /// reader rather than a second copy of what a key reads as.</summary>
    internal static ElementKey Of(JsonNode? node, IReadOnlyList<string> keyMembers, FieldMetadata? elementMeta = null) =>
        Of(JsonSerializer.SerializeToElement(node), keyMembers, elementMeta);

    /// <summary>xEdit's extended sort key: the key, then what a wbStructExSK adds to it.</summary>
    public static ElementKey SortKeyOf(JsonElement element, FieldMetadata array, Func<string, uint?>? loadOrderFormIds = null) =>
        Of(element, SortMembers(array), array.ElementType, loadOrderFormIds);

    internal static ElementKey SortKeyOf(JsonNode? node, FieldMetadata array) =>
        Of(node, SortMembers(array), array.ElementType);

    private static IReadOnlyList<string> SortMembers(FieldMetadata array) =>
        [.. array.KeyMembers ?? [], .. array.ExtendedKeyMembers ?? []];

    private static FieldMetadata? MemberAt(FieldMetadata? meta, string keyPath)
    {
        foreach (var hop in keyPath.Split('.'))
            meta = meta?.Fields?.FirstOrDefault(f => f.Name == hop);
        return meta;
    }

    public static IComparer<ElementKey> Order { get; } = Comparer<ElementKey>.Create((a, b) => a.CompareTo(b));

    internal int CompareTo(ElementKey other)
    {
        for (var i = 0; i < Math.Min(Segments.Count, other.Segments.Count); i++)
        {
            var (mine, theirs) = (Segments[i], other.Segments[i]);
            var order = mine.Number is { } a && theirs.Number is { } b ? a.CompareTo(b) : 0;
            if (order == 0) order = string.CompareOrdinal(mine.Text, theirs.Text);
            if (order != 0) return order;
        }
        return Segments.Count.CompareTo(other.Segments.Count);
    }

    private static IEnumerable<(double?, string)> ReadElement(
        JsonElement element, string keyPath, FieldMetadata? member, Func<string, uint?>? loadOrderFormIds)
    {
        var current = element;
        foreach (var hop in keyPath.Split('.'))
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(hop, out current))
                return [DefaultOf(member)];
        }
        return current.ValueKind == JsonValueKind.Object && member?.Fields is { } fields
            ? MembersOf(current, fields, loadOrderFormIds)
            : [Read(current, member, loadOrderFormIds)];
    }

    // An object reads as its members in turn, as xEdit's struct sort key joins its members', and a
    // union as its leaf's: COED's owner is one Mutagen union of its leaves' members.
    private static IEnumerable<(double?, string)> MembersOf(
        JsonElement obj, IReadOnlyList<FieldMetadata> fields, Func<string, uint?>? loadOrderFormIds)
    {
        var leaf = obj.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out var named) ? named.GetString() : null;
        return fields
            .Where(f => !f.IsDiscriminator && (f.Variants is not { } variants || (leaf != null && variants.ContainsKey(leaf))))
            .SelectMany(f => ReadElement(obj, f.Name, DocumentNodes.Variant(f, leaf), loadOrderFormIds));
    }

    private static (double?, string) Read(JsonElement current, FieldMetadata? member, Func<string, uint?>? loadOrderFormIds = null) =>
        current.ValueKind switch
        {
            JsonValueKind.Number => (current.GetDouble(), current.GetDouble().ToString(CultureInfo.InvariantCulture)),
            JsonValueKind.String when member?.Type == "formKey" && loadOrderFormIds != null =>
                (loadOrderFormIds(DocumentNodes.StringValueOf(current)) ?? Unloaded, DocumentNodes.StringValueOf(current)),
            JsonValueKind.String => (null, DocumentNodes.StringValueOf(current)),
            JsonValueKind.True or JsonValueKind.False => (null, current.GetRawText()),
            // A flags member is an array of names (ScenePhaseFragment.Flags keys a fragment); its
            // order is its bits', read off the members the schema declares.
            JsonValueKind.Array => (FlagBits(current, member), string.Join(", ", current.EnumerateArray().Select(e => e.ToString()))),
            JsonValueKind.Object => (null, current.GetRawText()),
            _ => Absent,
        };

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
    // default: what the same element spelled out would read as. A nullable one is unset instead.
    private static (double?, string) DefaultOf(FieldMetadata? member) => member switch
    {
        { AllowsNull: true } => Absent,
        { Default: { } declared } => Read(JsonSerializer.SerializeToElement(declared), member),
        { Type: "int" or "float" } => (0, "0"),
        { Type: "bool" } => (null, "false"),
        { Type: "flags" } => (0, ""),
        _ => Absent,
    };

    private static (double?, string) Absent => (null, "");
}
