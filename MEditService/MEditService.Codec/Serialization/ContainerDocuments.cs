using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Codec.Serialization;

/// <summary>A container's embedded children read out of its own document, by the slot facts
/// <see cref="RecordTypes"/> holds.</summary>
public sealed class ContainerDocuments(GameRelease release)
{
    /// <summary><c>Document</c> is the child's subtree of its owner's document; <c>SlotIndex</c> is its
    /// GRUP position. <c>RecordType</c> is null when nothing names a type this game has.</summary>
    public readonly record struct ChildDocument(
        string SlotName, int SlotIndex, string FormKey, string? RecordType, Document Document)
    {
        /// <summary>Why no type resolves, for a child whose <c>RecordType</c> is null.</summary>
        public string WhyUntyped =>
            Document.StringAt(LoquiUnions.UnionTypeDiscriminator) is { } named
                ? $"its '{SlotName}' names '{FormKey}' a '{named}', and its slot holds no record type of that name"
                : $"its '{SlotName}' names '{FormKey}' with no '{LoquiUnions.UnionTypeDiscriminator}' naming its type, " +
                  "and its slot holds more than one record type";

        public string? EditorId => Document.EditorId.EditorId;
    }

    private readonly RecordTypes _types = RecordTypes.For(release);

    /// <summary>Empty for a record type with no child slots. A slot the document omits is a slot with
    /// no children.</summary>
    public IEnumerable<ChildDocument> ChildrenOf(string ownerRecordType, Document owner) =>
        owner.ChildrenOf(ownerRecordType, _types);

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
            child.Document.Element.GetRawText(),
            release,
            child.Document.Element.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out _) ? null : child.RecordType);

    /// <summary>The direct container of <paramref name="formKey"/> inside
    /// <paramref name="owner"/>, and its slot. A worldspace's top cell holds its placed
    /// references, so the container may itself be embedded.</summary>
    public DocumentContainment? ContainmentOf(string ownerRecordType, Document owner, string formKey) =>
        owner.ContainmentOf(ownerRecordType, formKey, _types);

    /// <summary>The child <paramref name="formKey"/> names anywhere inside <paramref name="ownerBytes"/>.
    /// Null when no embedded slot carries it, the text is no JSON, or no owner type resolves.</summary>
    public ChildDocument? EmbeddedChild(string? ownerRecordType, byte[] ownerBytes, string formKey) =>
        EmbeddedChildLocator.OwnerTypeOf(ownerRecordType, ownerBytes, _types) is { } ownerType
            ? Document.Read(ownerBytes)?.EmbeddedDescendantsOf(ownerType, _types)
                .Cast<ChildDocument?>()
                .FirstOrDefault(child => string.Equals(child?.FormKey, formKey, StringComparison.Ordinal))
            : null;
}
