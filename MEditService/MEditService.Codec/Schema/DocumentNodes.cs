using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;

namespace MEditService.Codec.Schema;

/// <summary>Reads and rewrites of the stored document by the schema's own paths. An element read is
/// handed out cloned, so it outlives the <see cref="JsonDocument"/> it was parsed from.</summary>
public static class DocumentNodes
{
    /// <summary>The member at a dotted path from the root, or null where the document omits it — which
    /// the codec does for a member equal to its default.</summary>
    public static JsonElement? At(JsonElement root, string dottedPath)
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
    public static bool SameValue(JsonElement a, JsonElement b) =>
        a.ValueKind == JsonValueKind.Number && b.ValueKind == JsonValueKind.Number
            ? a.GetDouble().CompareTo(b.GetDouble()) == 0
            : a.GetRawText() == b.GetRawText();

    // Two columns spelling one value: the codec's own text, since JsonElement has no Equals(), as a
    // compare reads it; and against an absent side, what the codec omits.
    public static bool SameNode(object? a, object? b, FieldMetadata shape, bool absentMeansDefault)
    {
        if (a is JsonElement ja && b is JsonElement jb)
            return ja.GetRawText() == jb.GetRawText() || ComparedText(ja, shape) == ComparedText(jb, shape);
        if (a is null && b is null) return true;
        if (a is null || b is null)
            return absentMeansDefault && (a ?? b) is JsonElement present && IsOmitted(present, shape);
        return Equals(a, b);
    }

    /// <summary>The codec's text with every keyed array in extended-key order and every colour as it
    /// reads, so one value reads alike whatever order holds its keyed arrays and whatever alpha a
    /// colour holding none carries.</summary>
    public static string ComparedText(JsonElement value, FieldMetadata meta) =>
        Rewrite(JsonNode.Parse(value.GetRawText()), meta, AsCompared)?.ToJsonString() ?? "null";

    private static JsonNode? AsCompared(JsonNode node, FieldMetadata meta)
    {
        switch (node)
        {
            case JsonValue leaf when meta.Type == ColorReading.ApiType && leaf.TryGetValue<string>(out var text):
                return JsonValue.Create(ColorReading.Of(text, meta.HoldsAlpha));
            case JsonArray array when meta.KeyMembers != null:
                // A stable sort by the extended key, so elements sharing it keep their turn, as they align.
                var sorted = array.OrderBy(element => ElementKey.SortKeyOf(element, meta), ElementKey.Order).ToList();
                array.Clear();
                foreach (var element in sorted) array.Add(element);
                return array;
            default:
                return node;
        }
    }

    /// <summary>The value, mutated in place, with <paramref name="rewrite"/> given every node in it
    /// beside the shape the schema gives that node, children before the node holding them.</summary>
    public static JsonNode? Rewrite(JsonNode? node, FieldMetadata meta, Func<JsonNode, FieldMetadata, JsonNode?> rewrite)
    {
        switch (node)
        {
            case JsonObject obj when meta.Fields is { } fields:
                foreach (var field in fields)
                {
                    if (obj[field.Name] is { } child && Rewrite(child, VariantFor(field, obj), rewrite) is var rewritten && rewritten != child)
                        obj[field.Name] = rewritten;
                }
                break;
            case JsonArray array when meta.ElementType is { } elementMeta:
                for (var i = 0; i < array.Count; i++)
                {
                    if (array[i] is { } element && Rewrite(element, elementMeta, rewrite) is var rewritten && rewritten != element)
                        array[i] = rewritten;
                }
                break;
        }
        return node is null ? null : rewrite(node, meta);
    }

    // What the codec omits: the declared default where the metadata spells one, else a zero number,
    // false, an empty list or object, and a link to nothing.
    private static bool IsOmitted(JsonElement value, FieldMetadata meta) => meta.Default is { } declared
        ? SameValue(value, JsonSerializer.SerializeToElement(declared))
            || ComparedText(value, meta) == ComparedText(JsonSerializer.SerializeToElement(declared), meta)
        : value.ValueKind switch
        {
            JsonValueKind.Number => value.GetRawText().Trim('-', '0', '.') is "" or "e0",
            JsonValueKind.False => true,
            JsonValueKind.String => meta.Type == "formKey" && value.GetString() == "Null",
            JsonValueKind.Array => value.GetArrayLength() == 0,
            JsonValueKind.Object => !value.EnumerateObject().Any(),
            _ => false,
        };

    /// <summary>The shape a member has under the object holding it: its own, or the variant the
    /// object's discriminator names when the member's type varies by leaf.</summary>
    public static FieldMetadata VariantFor(FieldMetadata member, JsonElement? owner) =>
        owner is { ValueKind: JsonValueKind.Object } obj
            && obj.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out var leaf)
            && leaf.ValueKind == JsonValueKind.String
            ? Variant(member, leaf.GetString())
            : member;

    /// <summary>The same question over the write path's mutable tree.</summary>
    public static FieldMetadata VariantFor(FieldMetadata member, JsonNode? owner) =>
        owner is JsonObject obj && obj[LoquiUnions.UnionTypeDiscriminator] is JsonValue leaf && leaf.TryGetValue<string>(out var name)
            ? Variant(member, name)
            : member;

    /// <summary>The shape a member has under a named union leaf; its own where no variant
    /// answers to that name.</summary>
    public static FieldMetadata Variant(FieldMetadata member, string? leaf) =>
        leaf != null && member.Variants is { } variants && variants.TryGetValue(leaf, out var variant) ? variant : member;

    /// <summary>The EditorID a record's own node names; null when it names none. One that is no string
    /// throws: a reader of hand-edited text refuses it first, through <see cref="HoldsEditorIdThatIsNoString"/>.</summary>
    public static string? EditorIdOf(JsonElement record)
    {
        if (EditorIdNode(record) is not { } editorId) return null;
        return editorId.ValueKind == JsonValueKind.String
            ? StringValueOf(editorId)
            : throw new InvalidOperationException($"The record's '{RecordMembers.EditorId}' is not a string.");
    }

    public static bool HoldsEditorIdThatIsNoString(JsonElement record) =>
        EditorIdNode(record) is { ValueKind: not JsonValueKind.String };

    private static JsonElement? EditorIdNode(JsonElement record) =>
        record.ValueKind == JsonValueKind.Object
        && record.TryGetProperty(RecordMembers.EditorId, out var editorId)
        && editorId.ValueKind != JsonValueKind.Null
            ? editorId
            : null;

    /// <summary>The string value of a node the caller has already checked is a JSON string.</summary>
    public static string StringValueOf(JsonElement element) =>
        element.GetString() ?? throw new InvalidOperationException("Expected a JSON string value to read a non-null string.");
}
