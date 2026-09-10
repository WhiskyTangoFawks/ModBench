using System.Reflection;
using System.Text.Json;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Core.Serialization;

/// <summary>A container's embedded children read out of its own document, by the slot names
/// <see cref="ContainerMembers"/> derives.</summary>
internal sealed class ContainerDocuments(GameRelease release, IReadOnlyDictionary<string, RecordTableSchema> schemas)
{
    /// <summary><c>Node</c> is the child's subtree of its owner's document, which spells an ambiguous
    /// child's own type; <c>SlotIndex</c> is its GRUP position.</summary>
    internal readonly record struct ChildDocument(
        string SlotName, int SlotIndex, string FormKey, string RecordType, JsonElement Node);

    private const string FormKeyMember = "FormKey";

    private readonly RecordTypeDispatch _dispatch = RecordTypeDispatch.For(release);

    /// <summary>The concrete class name a container's slot table is keyed by, which is the codec's
    /// spelling of the type rather than the schema's table name.</summary>
    internal string ContainerTypeOf(string recordType) => _dispatch.ConcreteFor(recordType)?.Name ?? recordType;

    /// <summary>The schema table a document's own <c>MutagenObjectType</c> names, for a path that does
    /// not decide the type. Null when nothing in the game's schema answers to it.</summary>
    internal string? RecordTypeNamed(string? declaredType) =>
        declaredType is not null && _dispatch.ConcreteFor(declaredType) is { } concrete ? TableFor(concrete) : null;

    /// <summary>Whether this is the game's cell — the one record type whose place in the world is a
    /// structure rather than a member of its own document.</summary>
    internal bool IsCell(string recordType) => _dispatch.IsCell(recordType);

    /// <summary>Empty for a record type with no child slots. A slot the document omits is a slot with
    /// no children.</summary>
    internal IEnumerable<ChildDocument> ChildrenOf(string ownerRecordType, JsonElement ownerRoot)
    {
        if (_dispatch.ConcreteFor(ownerRecordType) is not { } owner) yield break;
        if (!ContainerMembers.Derived.ChildFieldsByType.TryGetValue(owner.Name, out var slots)) yield break;
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

    /// <summary>The child's own standalone document: the bytes the codec produces for it as a record
    /// in its own right, so what a container yields and what ingest stores are one text.</summary>
    internal string TextOf(RecordTextCodec codec, ChildDocument child) =>
        codec.RoundTrip(
            child.Node.GetRawText(),
            release,
            child.Node.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out _) ? null : child.RecordType);

    private ChildDocument? Child(Type owner, string slotName, int index, JsonElement node)
    {
        if (node.ValueKind != JsonValueKind.Object) return null;
        if (!node.TryGetProperty(FormKeyMember, out var formKey) || formKey.ValueKind != JsonValueKind.String) return null;

        return new ChildDocument(
            slotName, index, formKey.GetString()!, RecordTypeOf(owner, slotName, node), node.Clone());
    }

    // The child's own spelling where the document carries it, else the slot's declared element type:
    // a slot whose member type is concrete writes no discriminator.
    private string RecordTypeOf(Type owner, string slotName, JsonElement node) =>
        TableFor(DeclaredType(node) ?? SlotElementType(owner, slotName));

    private Type? DeclaredType(JsonElement node) =>
        node.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out var named) && named.ValueKind == JsonValueKind.String
            ? _dispatch.ConcreteFor(named.GetString()!)
            : null;

    private static Type? SlotElementType(Type owner, string slotName)
    {
        var member = owner.GetProperty(slotName, BindingFlags.Public | BindingFlags.Instance)?.PropertyType;
        if (member == null) return null;

        return member.GetInterfaces()
            .Where(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>))
            .Select(i => i.GetGenericArguments()[0])
            .FirstOrDefault()
            ?? member;
    }

    // SourceRecordType's answer, asked of a type rather than an instance: the table whose type it is
    // one of, else the GRUP signature the schema names tables after, else the lowercased class name.
    private string TableFor(Type? concrete)
    {
        if (concrete == null) return string.Empty;

        foreach (var (tableName, schema) in schemas)
        {
            if (schema.RecordType.IsAssignableFrom(concrete)) return tableName;
        }

        return GrupSignatureOf(concrete) ?? concrete.Name.ToLowerInvariant();
    }

    private static string? GrupSignatureOf(Type type) =>
        type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static)?.GetValue(null)
            is Mutagen.Bethesda.Plugins.RecordType grup
            ? grup.Type.ToLowerInvariant()
            : null;
}
