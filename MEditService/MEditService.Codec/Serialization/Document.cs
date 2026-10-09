using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using ChildDocument = MEditService.Codec.Serialization.ContainerDocuments.ChildDocument;

namespace MEditService.Codec.Serialization;

/// <summary>A record's document: the JSON document itself, addressed by path, and the only model of the
/// record (ADR-0005).</summary>
public sealed class Document
{
    private const string NoObjectRoot = "its root is not a JSON object.";

    private readonly JsonElement _root;

    private Document(JsonElement root) => _root = root;

    /// <summary>False, with the reader's words, when the text is no JSON or its root is no object.</summary>
    public static bool TryRead(string text, [NotNullWhen(true)] out Document? document, [NotNullWhen(false)] out string? whyNot) =>
        TryParse(() => JsonElement.Parse(text), out document, out whyNot);

    /// <summary>Text already known to be a record's document; throws, with the reader's words, for text
    /// that is none.</summary>
    public static Document Parse(string text) =>
        TryRead(text, out var document, out var whyNot) ? document : throw new InvalidDataException(whyNot);

    internal static Document? Read(byte[] utf8) => TryParse(() => JsonElement.Parse(utf8), out var document, out _) ? document : null;

    private static bool TryParse(
        Func<JsonElement> parse, [NotNullWhen(true)] out Document? document, [NotNullWhen(false)] out string? whyNot)
    {
        try
        {
            document = Over(parse());
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

    /// <summary>A node the caller already holds, read as a document; null for one that is no object.</summary>
    internal static Document? Over(JsonElement node) => node.ValueKind == JsonValueKind.Object ? new(node) : null;

    /// <summary>A node a record's own document roots, which is always an object.</summary>
    internal static Document OfRecord(JsonElement record) =>
        Over(record) ?? throw new InvalidOperationException($"A record's document is a JSON object, and this node is {record.ValueKind}.");

    /// <summary>The string at <paramref name="path"/>, one member name per hop from the root; null where the
    /// document omits it or holds no string there.</summary>
    public string? StringAt(params ReadOnlySpan<string> path) =>
        At(path) is { ValueKind: JsonValueKind.String } value ? DocumentNodes.StringValueOf(value) : null;

    /// <summary>The integer at <paramref name="path"/>; null where the document omits it or holds no
    /// integer there.</summary>
    public long? IntegerAt(params ReadOnlySpan<string> path) =>
        At(path) is { ValueKind: JsonValueKind.Number } value && value.TryGetInt64(out var integer) ? integer : null;

    /// <summary>The object at <paramref name="path"/>, read as a document of its own.</summary>
    public Document? DocumentAt(params ReadOnlySpan<string> path) => At(path) is { } node ? Over(node) : null;

    /// <summary>The document's text, written compact.</summary>
    public string Text => JsonSerializer.Serialize(_root);

    public Document With(long value, params ReadOnlySpan<string> path)
    {
        var member = path[^1];
        var owner = path[..^1].ToArray();
        return Edited(root => OwnerOf(root, owner)[member] = value);
    }

    /// <summary>The member at <paramref name="path"/> as <paramref name="from"/> holds it, absent where
    /// <paramref name="from"/> omits it.</summary>
    public Document WithCopyOf(Document from, params ReadOnlySpan<string> path)
    {
        if (from.At(path) is not { ValueKind: not JsonValueKind.Null } copied) return Without(path);
        var member = path[^1];
        var owner = path[..^1].ToArray();
        return Edited(root => OwnerOf(root, owner)[member] = JsonNode.Parse(copied.GetRawText()));
    }

    public Document Without(params ReadOnlySpan<string> path)
    {
        if (At(path) is null) return this;
        var member = path[^1];
        var owner = path[..^1].ToArray();
        return Edited(root => OwnerOf(root, owner).Remove(member));
    }

    /// <summary>This document without the other spellings of <paramref name="column"/>'s value, which sit beside
    /// the member they spell again and which the reader takes over it.</summary>
    public Document WithoutAliasesOf(ColumnSpec column)
    {
        var owner = (column.Synthetic?.BackingPath ?? column.PropertyName).Split('.')[..^1];
        var document = this;
        foreach (var alias in column.Aliases) document = document.Without([.. owner, alias]);
        return document;
    }

    /// <summary>A copy of this document changed by <paramref name="edit"/> on its mutable tree.</summary>
    internal Document Edited(Action<JsonObject> edit)
    {
        var root = Tree();
        edit(root);
        return Of(root);
    }

    internal JsonObject Tree() =>
        JsonNode.Parse(_root.GetRawText()) as JsonObject
            ?? throw new InvalidOperationException("Expected a document's root to stay a JSON object.");

    internal static Document Of(JsonObject root) => new(JsonElement.Parse(root.ToJsonString()));

    /// <summary>The object at <paramref name="path"/> in <paramref name="root"/>; where the tree holds none,
    /// made when <paramref name="creating"/>, and otherwise null.</summary>
    internal static JsonObject? OwnerAt(JsonObject root, IEnumerable<string> path, bool creating)
    {
        var owner = root;
        foreach (var hop in path)
        {
            if (owner[hop] is not JsonObject inner)
            {
                if (!creating) return null;
                owner[hop] = inner = new JsonObject();
            }
            owner = inner;
        }
        return owner;
    }

    internal static JsonObject OwnerOf(JsonObject root, IEnumerable<string> path) =>
        OwnerAt(root, path, creating: true) ?? throw new InvalidOperationException("Expected a walk that makes what it lacks to reach its owner.");

    internal JsonElement? At(params ReadOnlySpan<string> path)
    {
        var current = _root;
        foreach (var hop in path)
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

    public (int X, int Y)? Grid
    {
        get
        {
            if (At(RecordTypes.CellGridMember) is not { ValueKind: JsonValueKind.Object }) return null;
            return PlacedCell.Components(StringAt(RecordTypes.CellGridMember, PlacedCell.GridPointMember)) is [var x, var y]
                ? ((int)x, (int)y)
                : (0, 0);
        }
    }

    internal bool CarriesHeaderFlag(int bit) =>
        At(RecordHeaderFlags.Member) is { ValueKind: JsonValueKind.Number } flags && (flags.GetInt32() & bit) != 0;

    /// <summary>The Partial Form bit, read only where a record of <paramref name="recordType"/> can carry
    /// it.</summary>
    internal bool IsPartialForm(Type recordType) =>
        PartialFormFlag.IsPartialFormable(recordType) && CarriesHeaderFlag(PartialFormFlag.Bit);
}
