using System.Text.Json;
using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Codec.Serialization;

/// <summary>A container's embedded children read out of its own document, by the slot facts
/// <see cref="ContainerSlots"/> holds.</summary>
public sealed class ContainerDocuments(GameRelease release, IReadOnlyDictionary<string, RecordTableSchema> schemas)
{
    /// <summary><c>Node</c> is the child's subtree of its owner's document; <c>SlotIndex</c> is its
    /// GRUP position. <c>RecordType</c> is null when nothing names a type this game has.</summary>
    public readonly record struct ChildDocument(
        string SlotName, int SlotIndex, string FormKey, string? RecordType, JsonElement Node)
    {
        /// <summary>Why no type resolves, for a child whose <c>RecordType</c> is null.</summary>
        public string WhyUntyped =>
            Node.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out var named) && named.ValueKind == JsonValueKind.String
                ? $"its '{SlotName}' names '{FormKey}' a '{named.GetString()}', and this game has no record type of that name"
                : $"its '{SlotName}' names '{FormKey}' with no '{LoquiUnions.UnionTypeDiscriminator}' naming its type, " +
                  "and its slot holds more than one record type";

        public string? EditorId =>
            Node.TryGetProperty(RecordMembers.EditorId, out var editorId) && editorId.ValueKind == JsonValueKind.String
                ? DocumentNodes.StringValueOf(editorId)
                : null;
    }

    private const string FormKeyMember = RecordMembers.FormKey;

    private readonly RecordTypeDispatch _dispatch = RecordTypeDispatch.For(release);

    private readonly ContainerSlots _slots = ContainerSlots.For(release);

    /// <summary>The concrete class name a container's slot table is keyed by, which is the codec's
    /// spelling of the type rather than the schema's table name.</summary>
    public string ContainerTypeOf(string recordType) => _dispatch.ConcreteFor(recordType)?.Name ?? recordType;

    /// <summary>The schema table a document's own <c>MutagenObjectType</c> names, for a path that does
    /// not decide the type. Null when nothing in the game's schema answers to it.</summary>
    public string? RecordTypeNamed(string? declaredType) =>
        declaredType is not null && _dispatch.ConcreteFor(declaredType) is { } concrete ? TableFor(concrete) : null;

    /// <summary>Whether this is the game's cell — the one record type whose place in the world is a
    /// structure rather than a member of its own document.</summary>
    public bool IsCell(string recordType) => _dispatch.IsCell(recordType);

    /// <summary>Empty for a record type with no child slots. A slot the document omits is a slot with
    /// no children.</summary>
    public IEnumerable<ChildDocument> ChildrenOf(string ownerRecordType, JsonElement ownerRoot)
    {
        if (_dispatch.ConcreteFor(ownerRecordType) is not { } owner) yield break;
        var slots = _slots.ChildSlotsOf(owner.Name);
        if (slots.Count == 0) yield break;
        if (ownerRoot.ValueKind != JsonValueKind.Object) yield break;

        foreach (var slotName in slots)
        {
            if (!ownerRoot.TryGetProperty(slotName, out var slot)) continue;

            switch (slot.ValueKind)
            {
                case JsonValueKind.Object:
                    if (Child(owner, slotName, 0, slot) is { } single) yield return single;
                    break;
                case JsonValueKind.Array:
                    var index = 0;
                    foreach (var element in slot.EnumerateArray())
                    {
                        if (Child(owner, slotName, index, element) is { } item) yield return item;
                        index++;
                    }
                    break;
                default:
                    break;
            }
        }
    }

    /// <summary>The links a record holds in its own right: a child carried inline holds its own, so
    /// the owner's document drops the paths that lie under a child slot.</summary>
    public List<FormReference> OwnReferences(string ownerRecordType, IEnumerable<FormReference> references)
    {
        if (_dispatch.ConcreteFor(ownerRecordType) is not { } owner) return [.. references];
        var slots = _slots.ChildSlotsOf(owner.Name);
        return [.. references.Where(r => !slots.Contains(MemberOf(r.FieldPath)))];

        static string MemberOf(string path)
        {
            var end = path.AsSpan().IndexOfAny('.', '[');
            return end < 0 ? path : path[..end];
        }
    }

    /// <summary>The child's own standalone document: the bytes the codec produces for it as a record
    /// in its own right, so what a container yields and what ingest stores are one text.</summary>
    public string TextOf(RecordTextCodec codec, ChildDocument child) =>
        codec.RoundTrip(
            child.Node.GetRawText(),
            release,
            child.Node.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out _) ? null : child.RecordType);

    private ChildDocument? Child(Type owner, string slotName, int index, JsonElement node)
    {
        if (node.ValueKind != JsonValueKind.Object) return null;
        if (!node.TryGetProperty(FormKeyMember, out var formKey) || formKey.ValueKind != JsonValueKind.String) return null;

        return new ChildDocument(
            slotName, index, DocumentNodes.StringValueOf(formKey), RecordTypeOf(owner, slotName, node), node.Clone());
    }

    // The child's own spelling where the document carries it, else the slot's declared element type:
    // a slot whose member type is concrete writes no discriminator.
    private string? RecordTypeOf(Type owner, string slotName, JsonElement node) =>
        (DeclaredType(node) ?? SlotElementType(owner, slotName)) is { } concrete ? TableFor(concrete) : null;

    private Type? DeclaredType(JsonElement node) =>
        node.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out var named) && named.ValueKind == JsonValueKind.String
            ? _dispatch.ConcreteFor(DocumentNodes.StringValueOf(named))
            : null;

    private Type? SlotElementType(Type owner, string slotName) =>
        _slots.ElementTypeOf(owner.Name, slotName) is { } element ? _dispatch.ConcreteFor(element) : null;

    private string TableFor(Type concrete) => RecordTableName.Of(concrete, schemas);

    /// <summary>Every child a document carries inline, at any depth: a worldspace's own document
    /// holds its top cell, which holds its placed references.</summary>
    public IEnumerable<ChildDocument> EmbeddedDescendantsOf(string ownerRecordType, JsonElement ownerRoot)
    {
        var ownerType = ContainerTypeOf(ownerRecordType);
        foreach (var child in ChildrenOf(ownerRecordType, ownerRoot))
        {
            if (!_slots.IsEmbeddedSlot(ownerType, child.SlotName)) continue;
            yield return child;
            if (child.RecordType is not { } childType) continue;
            foreach (var deeper in EmbeddedDescendantsOf(childType, child.Node)) yield return deeper;
        }
    }

    /// <summary>The direct container of <paramref name="formKey"/> inside
    /// <paramref name="ownerRoot"/>, and its slot. A worldspace's top cell holds its placed
    /// references, so the container may itself be embedded.</summary>
    public DocumentContainment? ContainmentOf(string ownerRecordType, JsonElement ownerRoot, string formKey)
    {
        if (ownerRoot.ValueKind != JsonValueKind.Object
            || !ownerRoot.TryGetProperty(FormKeyMember, out var ownKey)
            || ownKey.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var ownerType = ContainerTypeOf(ownerRecordType);
        foreach (var child in ChildrenOf(ownerRecordType, ownerRoot))
        {
            if (string.Equals(child.FormKey, formKey, StringComparison.Ordinal))
                return new DocumentContainment(DocumentNodes.StringValueOf(ownKey), ownerRecordType, child.SlotName);

            if (!_slots.IsEmbeddedSlot(ownerType, child.SlotName) || child.RecordType is not { } childType) continue;
            if (ContainmentOf(childType, child.Node, formKey) is { } deeper) return deeper;
        }
        return null;
    }

    /// <summary>The child <paramref name="formKey"/> names anywhere inside <paramref name="ownerBytes"/>;
    /// null when no embedded slot of the owner carries it.</summary>
    public ChildDocument? EmbeddedChild(string? ownerRecordType, byte[] ownerBytes, string formKey)
    {
        var ownerType = EmbeddedChildLocator.ContainerTypeName(ownerRecordType, ownerBytes, release)
            ?? EmbeddedChildLocator.RootDiscriminator(ownerBytes);
        if (ownerType is null) return null;

        try
        {
            using var document = JsonDocument.Parse(ownerBytes);
            foreach (var child in EmbeddedDescendantsOf(ownerType, document.RootElement))
            {
                if (string.Equals(child.FormKey, formKey, StringComparison.Ordinal)) return child;
            }
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
