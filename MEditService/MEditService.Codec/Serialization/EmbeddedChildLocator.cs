using System.Text.Json;
using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Codec.Serialization;

/// <summary>Where an embedded child's text sits inside its owner's document: the child's own span,
/// the slot member carrying it, and what the text says the child is.</summary>
public readonly record struct EmbeddedChildSpan(
    int Start,
    int End,
    int SlotNameStart,
    int SlotValueEnd,
    bool SlotIsList,
    string? Discriminator);

/// <summary>A child an owner's document carries, and where.</summary>
internal readonly record struct EmbeddedChild(string FormKey, EmbeddedChildSpan Span);

/// <summary>The byte span a child occupies in its owner's document, keyed on the schema's slot
/// facts and reading nothing back as a live object. The splice and the document reads ask
/// here.</summary>
public static class EmbeddedChildLocator
{
    private const string FormKeyMember = RecordMembers.FormKey;

    /// <summary>Where <paramref name="formKey"/> sits inside <paramref name="ownerBytes"/>, or null
    /// when no child slot of the owner carries it.</summary>
    public static EmbeddedChildSpan? Find(
        byte[] ownerBytes, string? ownerRecordType, string formKey, GameRelease release)
    {
        foreach (var child in All(ownerBytes, ownerRecordType, release))
        {
            if (string.Equals(child.FormKey, formKey, StringComparison.Ordinal)) return child.Span;
        }
        return null;
    }

    /// <summary>Every child the owner's slots carry, at every depth, a child's own children before it. An
    /// owner whose record type names no slots reads its document's own discriminator. Malformed text
    /// carries none.</summary>
    internal static IReadOnlyList<EmbeddedChild> All(byte[] ownerBytes, string? ownerRecordType, GameRelease release)
    {
        var found = new List<EmbeddedChild>();
        try
        {
            var reader = new Utf8JsonReader(ownerBytes);
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject) return [];

            var types = RecordTypes.For(release);
            ScanObject(ref reader, OwnerTypeOf(ownerRecordType, ownerBytes, types), types, found);
            return found;
        }
        catch (JsonException)
        {
            return [];
        }
    }

    /// <summary>The class name the owner's slots are keyed by: its record type's, or its document's own
    /// discriminator where the record type names none.</summary>
    internal static string? OwnerTypeOf(string? ownerRecordType, byte[] ownerBytes, RecordTypes types) =>
        types.ContainerTypeOf(ownerRecordType) ?? Document.Read(ownerBytes)?.StringAt(LoquiUnions.UnionTypeDiscriminator);

    private readonly record struct ObjectScan(string? FormKey, string? Discriminator);

    // Enters on the object's '{' and leaves on its '}'.
    private static ObjectScan ScanObject(
        ref Utf8JsonReader reader, string? containerType, RecordTypes slots, List<EmbeddedChild> found)
    {
        string? ownFormKey = null;
        string? discriminator = null;

        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            var member = reader.GetString()
                ?? throw new InvalidOperationException("Expected a JSON property name to read a non-null string.");
            var memberStart = (int)reader.TokenStartIndex;
            reader.Read();

            if (reader.TokenType == JsonTokenType.String && member.Equals(FormKeyMember, StringComparison.Ordinal))
            {
                ownFormKey = reader.GetString() is { } written ? CanonicalFormKey.OfOrAsWritten(written) : null;
                continue;
            }
            if (reader.TokenType == JsonTokenType.String && member.Equals(LoquiUnions.UnionTypeDiscriminator, StringComparison.Ordinal))
            {
                discriminator = reader.GetString();
                containerType ??= discriminator;
                continue;
            }
            if (!slots.IsEmbeddedSlotOf(containerType, member))
            {
                reader.Skip();
                continue;
            }

            if (reader.TokenType == JsonTokenType.StartObject) InSingleSlot(ref reader, memberStart, slots, found);
            else if (reader.TokenType == JsonTokenType.StartArray) InListSlot(ref reader, memberStart, slots, found);
        }

        return new ObjectScan(ownFormKey, discriminator);
    }

    // Enters on the slot value's '{' and leaves on its '}'.
    private static void InSingleSlot(ref Utf8JsonReader reader, int memberStart, RecordTypes slots, List<EmbeddedChild> found)
    {
        var start = (int)reader.TokenStartIndex;
        var scan = ScanObject(ref reader, null, slots, found);
        var end = (int)reader.BytesConsumed;

        if (scan.FormKey is { } formKey)
            found.Add(new EmbeddedChild(formKey, new EmbeddedChildSpan(start, end, memberStart, end, SlotIsList: false, scan.Discriminator)));
    }

    // An element's span names where its list ends, which is known only once the reader leaves the list on its ']'.
    private static void InListSlot(ref Utf8JsonReader reader, int memberStart, RecordTypes slots, List<EmbeddedChild> found)
    {
        var elements = new List<int>();

        while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
        {
            if (reader.TokenType != JsonTokenType.StartObject)
            {
                reader.Skip();
                continue;
            }

            var start = (int)reader.TokenStartIndex;
            var scan = ScanObject(ref reader, null, slots, found);
            var end = (int)reader.BytesConsumed;
            if (scan.FormKey is not { } formKey) continue;

            elements.Add(found.Count);
            found.Add(new EmbeddedChild(formKey, new EmbeddedChildSpan(start, end, memberStart, end, SlotIsList: true, scan.Discriminator)));
        }

        var slotEnd = (int)reader.BytesConsumed;
        foreach (var element in elements) found[element] = found[element] with { Span = found[element].Span with { SlotValueEnd = slotEnd } };
    }
}
