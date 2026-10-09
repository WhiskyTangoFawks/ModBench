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

/// <summary>The byte span a child occupies in its owner's document, keyed on the schema's slot
/// facts and reading nothing back as a live object. The splice and the document reads ask
/// here.</summary>
public static class EmbeddedChildLocator
{
    private const string FormKeyMember = RecordMembers.FormKey;

    /// <summary>Where <paramref name="formKey"/> sits inside <paramref name="ownerBytes"/>, or null
    /// when no child slot of the owner carries it. An owner whose record type names no slots reads
    /// its document's own discriminator. Malformed text carries nothing.</summary>
    public static EmbeddedChildSpan? Find(
        byte[] ownerBytes, string? ownerRecordType, string formKey, GameRelease release)
    {
        try
        {
            var reader = new Utf8JsonReader(ownerBytes);
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject) return null;

            // The owner's own key is not a child of itself, so only what the scan found below it counts.
            var types = RecordTypes.For(release);
            return ScanObject(ref reader, OwnerTypeOf(ownerRecordType, ownerBytes, types), formKey, types).Deeper;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The class name the owner's slots are keyed by: its record type's, or its document's own
    /// discriminator where the record type names none.</summary>
    internal static string? OwnerTypeOf(string? ownerRecordType, byte[] ownerBytes, RecordTypes types) =>
        types.ContainerTypeOf(ownerRecordType) ?? RootDiscriminator(ownerBytes);

    private static string? RootDiscriminator(byte[] ownerBytes)
    {
        try
        {
            using var document = JsonDocument.Parse(ownerBytes);
            return document.RootElement.ValueKind == JsonValueKind.Object
                   && document.RootElement.TryGetProperty(LoquiUnions.UnionTypeDiscriminator, out var value)
                   && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private readonly record struct ObjectScan(string? FormKey, string? Discriminator, EmbeddedChildSpan? Deeper);

    // Enters on the object's '{' and leaves on its '}'.
    private static ObjectScan ScanObject(
        ref Utf8JsonReader reader, string? containerType, string formKey, RecordTypes slots)
    {
        string? ownFormKey = null;
        string? discriminator = null;
        EmbeddedChildSpan? found = null;

        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            var member = reader.GetString()
                ?? throw new InvalidOperationException("Expected a JSON property name to read a non-null string.");
            var memberStart = (int)reader.TokenStartIndex;
            reader.Read();

            if (reader.TokenType == JsonTokenType.String && member.Equals(FormKeyMember, StringComparison.Ordinal))
            {
                ownFormKey = reader.GetString();
                continue;
            }
            if (reader.TokenType == JsonTokenType.String && member.Equals(LoquiUnions.UnionTypeDiscriminator, StringComparison.Ordinal))
            {
                discriminator = reader.GetString();
                containerType ??= discriminator;
                continue;
            }
            if (found != null || !slots.IsEmbeddedSlotOf(containerType, member))
            {
                reader.Skip();
                continue;
            }

            found = reader.TokenType switch
            {
                JsonTokenType.StartObject => InSingleSlot(ref reader, formKey, memberStart, slots),
                JsonTokenType.StartArray => InListSlot(ref reader, formKey, memberStart, slots),
                _ => null,
            };
        }

        return new ObjectScan(ownFormKey, discriminator, found);
    }

    // Enters on the slot value's '{' and leaves on its '}'.
    private static EmbeddedChildSpan? InSingleSlot(
        ref Utf8JsonReader reader, string formKey, int memberStart, RecordTypes slots)
    {
        var start = (int)reader.TokenStartIndex;
        var scan = ScanObject(ref reader, null, formKey, slots);
        var end = (int)reader.BytesConsumed;

        if (scan.Deeper is { } deeper) return deeper;

        return string.Equals(scan.FormKey, formKey, StringComparison.Ordinal)
            ? new EmbeddedChildSpan(start, end, memberStart, end, SlotIsList: false, scan.Discriminator)
            : null;
    }

    private const int PendingSlotEnd = -1;

    // Every element is walked even after a hit, so the reader leaves this slot on its ']'.
    private static EmbeddedChildSpan? InListSlot(
        ref Utf8JsonReader reader, string formKey, int memberStart, RecordTypes slots)
    {
        EmbeddedChildSpan? found = null;

        while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
        {
            if (reader.TokenType != JsonTokenType.StartObject)
            {
                reader.Skip();
                continue;
            }

            var start = (int)reader.TokenStartIndex;
            var scan = ScanObject(ref reader, null, formKey, slots);
            var end = (int)reader.BytesConsumed;
            if (found != null) continue;

            if (scan.Deeper is { } deeper)
                found = deeper;
            else if (string.Equals(scan.FormKey, formKey, StringComparison.Ordinal))
                found = new EmbeddedChildSpan(start, end, memberStart, PendingSlotEnd, SlotIsList: true, scan.Discriminator);
        }

        // A hit from further down already names its own slot; only an element of this list waits for
        // where the list ends.
        return found is { SlotValueEnd: PendingSlotEnd } element
            ? element with { SlotValueEnd = (int)reader.BytesConsumed }
            : found;
    }
}
