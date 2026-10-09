using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using MEditService.Codec.Schema;
using ChildDocument = MEditService.Codec.Serialization.ContainerDocuments.ChildDocument;

namespace MEditService.Codec.Serialization;

/// <summary>A record's document read from its text: the JSON document itself, addressed by path, and the
/// only model of the record (ADR-0005).</summary>
internal sealed class Document
{
    private const string NoObjectRoot = "its root is not a JSON object.";

    private readonly JsonElement _root;

    private Document(JsonElement root) => _root = root;

    /// <summary>False, with the reader's words, when the text is no JSON or its root is no object.</summary>
    internal static bool TryRead(string text, [NotNullWhen(true)] out Document? document, [NotNullWhen(false)] out string? whyNot)
    {
        try
        {
            document = Over(JsonElement.Parse(text));
            whyNot = document is null ? NoObjectRoot : null;
            return document is not null;
        }
        catch (JsonException ex)
        {
            document = null;
            whyNot = ex.Message;
            return false;
        }
    }

    internal static Document? Read(byte[] utf8)
    {
        try
        {
            return Over(JsonElement.Parse(utf8));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>A node the caller already holds, read as a document; null for one that is no object.</summary>
    internal static Document? Over(JsonElement node) => node.ValueKind == JsonValueKind.Object ? new(node) : null;

    /// <summary>The string at a dotted path from the root; null where the document omits it or holds no
    /// string there.</summary>
    internal string? StringAt(string dottedPath) =>
        At(dottedPath) is { ValueKind: JsonValueKind.String } value ? DocumentNodes.StringValueOf(value) : null;

    private JsonElement? At(string dottedPath)
    {
        var current = _root;
        foreach (var hop in dottedPath.Split('.'))
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(hop, out current)) return null;
        }
        return current;
    }

    internal EditorIdRead EditorId => At(RecordMembers.EditorId) switch
    {
        null or { ValueKind: JsonValueKind.Null } => EditorIdRead.None,
        { ValueKind: JsonValueKind.String } editorId => EditorIdRead.Of(DocumentNodes.StringValueOf(editorId)),
        _ => EditorIdRead.Unreadable($"'{RecordMembers.EditorId}' is not a string"),
    };

    /// <summary>The children the document carries in its owner's child slots, by the slot facts
    /// <see cref="RecordTypes"/> holds; empty for a record type with none. A slot the document omits is a
    /// slot with no children.</summary>
    internal IEnumerable<ChildDocument> ChildrenOf(string ownerRecordType, RecordTypes types)
    {
        if (types.ContainerTypeOf(ownerRecordType) is not { } owner) yield break;

        foreach (var slotName in types.ChildSlotsOf(owner))
        {
            if (!_root.TryGetProperty(slotName, out var slot)) continue;

            switch (slot.ValueKind)
            {
                case JsonValueKind.Object:
                    if (Child(owner, slotName, 0, slot, types) is { } single) yield return single;
                    break;
                case JsonValueKind.Array:
                    var index = 0;
                    foreach (var element in slot.EnumerateArray())
                    {
                        if (Child(owner, slotName, index, element, types) is { } item) yield return item;
                        index++;
                    }
                    break;
                default:
                    break;
            }
        }
    }

    private static ChildDocument? Child(string owner, string slotName, int index, JsonElement node, RecordTypes types) =>
        Over(node) is { } child && child.StringAt(RecordMembers.FormKey) is { } formKey
            ? new ChildDocument(slotName, index, formKey, child.RecordTypeIn(owner, slotName, types), node.Clone())
            : null;

    // The child's own spelling where the document carries one, else the slot's declared element type:
    // a slot whose member type is concrete writes no discriminator. A spelling no type the slot holds
    // answers to is no type.
    private string? RecordTypeIn(string owner, string slotName, RecordTypes types)
    {
        var concrete = StringAt(LoquiUnions.UnionTypeDiscriminator) is { } spelled
            ? SpelledTypeHeld(owner, slotName, spelled, types)
            : SlotElementType(owner, slotName, types);
        return concrete is null ? null : types.TableOf(concrete);
    }

    private static Type? SpelledTypeHeld(string owner, string slotName, string spelled, RecordTypes types) =>
        types.ConcreteFor(spelled) is { } type && types.HeldBy(owner, slotName).Any(held => held.IsAssignableFrom(type)) ? type : null;

    private static Type? SlotElementType(string owner, string slotName, RecordTypes types) =>
        types.ElementTypeOf(owner, slotName) is { } element ? types.ConcreteFor(element) : null;

    /// <summary>Every child the document carries inline, at any depth: a worldspace's own document holds
    /// its top cell, which holds its placed references.</summary>
    internal IEnumerable<ChildDocument> EmbeddedDescendantsOf(string ownerRecordType, RecordTypes types)
    {
        foreach (var child in ChildrenOf(ownerRecordType, types))
        {
            if (!types.IsEmbeddedSlot(ownerRecordType, child.SlotName)) continue;
            yield return child;
            if (child.RecordType is not { } childType) continue;
            foreach (var deeper in new Document(child.Node).EmbeddedDescendantsOf(childType, types)) yield return deeper;
        }
    }

    /// <summary>The direct container of <paramref name="formKey"/> inside the document, and its slot. A
    /// worldspace's top cell holds its placed references, so the container may itself be embedded.</summary>
    internal DocumentContainment? ContainmentOf(string ownerRecordType, string formKey, RecordTypes types)
    {
        if (StringAt(RecordMembers.FormKey) is not { } ownKey) return null;

        foreach (var child in ChildrenOf(ownerRecordType, types))
        {
            if (string.Equals(child.FormKey, formKey, StringComparison.Ordinal))
                return new DocumentContainment(ownKey, ownerRecordType, child.SlotName);

            if (!types.IsEmbeddedSlot(ownerRecordType, child.SlotName) || child.RecordType is not { } childType) continue;
            if (new Document(child.Node).ContainmentOf(childType, formKey, types) is { } deeper) return deeper;
        }
        return null;
    }

    /// <summary>The cell's grid, or null when its document carries none. The codec omits a zero point.</summary>
    internal (int X, int Y)? Grid
    {
        get
        {
            if (At(RecordTypes.CellGridMember) is not { ValueKind: JsonValueKind.Object }) return null;
            return PlacedCell.Components(StringAt($"{RecordTypes.CellGridMember}.{PlacedCell.GridPointMember}")) is [var x, var y]
                ? ((int)x, (int)y)
                : (0, 0);
        }
    }

    /// <summary>Whether the record header's flags carry <paramref name="bit"/>; the document omits them when
    /// none is set.</summary>
    internal bool CarriesHeaderFlag(int bit) =>
        At(RecordHeaderFlags.Member) is { ValueKind: JsonValueKind.Number } flags && (flags.GetInt32() & bit) != 0;

    /// <summary>The Partial Form bit, read only where a record of <paramref name="recordType"/> can carry
    /// it.</summary>
    internal bool IsPartialForm(Type recordType) =>
        PartialFormFlag.IsPartialFormable(recordType) && CarriesHeaderFlag(PartialFormFlag.Bit);
}
