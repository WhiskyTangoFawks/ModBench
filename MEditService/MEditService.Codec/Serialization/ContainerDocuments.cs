using System.Text.Json;
using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Codec.Serialization;

/// <summary>A container's embedded children read out of its own document, by the slot facts
/// <see cref="RecordTypes"/> holds.</summary>
public sealed class ContainerDocuments(GameRelease release)
{
    /// <summary><c>Node</c> is the child's subtree of its owner's document; <c>SlotIndex</c> is its
    /// GRUP position. <c>RecordType</c> is null when nothing names a type this game has.</summary>
    public readonly record struct ChildDocument(
        string SlotName, int SlotIndex, string FormKey, string? RecordType, JsonElement Node)
    {
        /// <summary>Why no type resolves, for a child whose <c>RecordType</c> is null.</summary>
        public string WhyUntyped =>
            Node.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out var named) && named.ValueKind == JsonValueKind.String
                ? $"its '{SlotName}' names '{FormKey}' a '{named.GetString()}', and its slot holds no record type of that name"
                : $"its '{SlotName}' names '{FormKey}' with no '{LoquiUnions.UnionTypeDiscriminator}' naming its type, " +
                  "and its slot holds more than one record type";

        public string? EditorId => DocumentNodes.EditorIdOf(Node).EditorId;
    }

    private const string FormKeyMember = RecordMembers.FormKey;

    private readonly RecordTypes _types = RecordTypes.For(release);

    /// <summary>Empty for a record type with no child slots. A slot the document omits is a slot with
    /// no children.</summary>
    public IEnumerable<ChildDocument> ChildrenOf(string ownerRecordType, JsonElement ownerRoot)
    {
        if (_types.ContainerTypeOf(ownerRecordType) is not { } owner) yield break;
        var slots = _types.ChildSlotsOf(owner);
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
        var slots = _types.ChildSlotsOf(ownerRecordType);
        return [.. references.Where(r => !slots.Contains(MemberOf(r.FieldPath)))];

        static string MemberOf(string path)
        {
            var end = path.AsSpan().IndexOfAny('.', '[');
            return end < 0 ? path : path[..end];
        }
    }

    /// <summary>The child's own standalone document: the bytes the codec produces for it as a record
    /// in its own right, so what a container yields and what ingest stores are one text.</summary>
    public string TextOf(ChildDocument child) =>
        RecordTextCodec.RoundTrip(
            child.Node.GetRawText(),
            release,
            child.Node.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out _) ? null : child.RecordType);

    private ChildDocument? Child(string owner, string slotName, int index, JsonElement node)
    {
        if (node.ValueKind != JsonValueKind.Object) return null;
        if (!node.TryGetProperty(FormKeyMember, out var formKey) || formKey.ValueKind != JsonValueKind.String) return null;

        return new ChildDocument(
            slotName, index, DocumentNodes.StringValueOf(formKey), RecordTypeOf(owner, slotName, node), node.Clone());
    }

    // The child's own spelling where the document carries one, else the slot's declared element type:
    // a slot whose member type is concrete writes no discriminator. A spelling no type the slot holds
    // answers to is no type.
    private string? RecordTypeOf(string owner, string slotName, JsonElement node)
    {
        var concrete = node.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out var named) && named.ValueKind == JsonValueKind.String
            ? SpelledTypeHeld(owner, slotName, DocumentNodes.StringValueOf(named))
            : SlotElementType(owner, slotName);
        return concrete is null ? null : _types.TableOf(concrete);
    }

    private Type? SpelledTypeHeld(string owner, string slotName, string spelled) =>
        _types.ConcreteFor(spelled) is { } type && _types.HeldBy(owner, slotName).Any(held => held.IsAssignableFrom(type)) ? type : null;

    private Type? SlotElementType(string owner, string slotName) =>
        _types.ElementTypeOf(owner, slotName) is { } element ? _types.ConcreteFor(element) : null;

    /// <summary>Every child a document carries inline, at any depth: a worldspace's own document
    /// holds its top cell, which holds its placed references.</summary>
    internal IEnumerable<ChildDocument> EmbeddedDescendantsOf(string ownerRecordType, JsonElement ownerRoot)
    {
        foreach (var child in ChildrenOf(ownerRecordType, ownerRoot))
        {
            if (!_types.IsEmbeddedSlot(ownerRecordType, child.SlotName)) continue;
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

        foreach (var child in ChildrenOf(ownerRecordType, ownerRoot))
        {
            if (string.Equals(child.FormKey, formKey, StringComparison.Ordinal))
                return new DocumentContainment(DocumentNodes.StringValueOf(ownKey), ownerRecordType, child.SlotName);

            if (!_types.IsEmbeddedSlot(ownerRecordType, child.SlotName) || child.RecordType is not { } childType) continue;
            if (ContainmentOf(childType, child.Node, formKey) is { } deeper) return deeper;
        }
        return null;
    }

    /// <summary>The child <paramref name="formKey"/> names anywhere inside <paramref name="ownerBytes"/>.
    /// Null when no embedded slot carries it, the text is no JSON, or no owner type resolves.</summary>
    public ChildDocument? EmbeddedChild(string? ownerRecordType, byte[] ownerBytes, string formKey)
    {
        if (EmbeddedChildLocator.OwnerTypeOf(ownerRecordType, ownerBytes, _types) is not { } ownerType) return null;

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
