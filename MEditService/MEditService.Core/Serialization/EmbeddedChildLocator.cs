using System.Text.Json;
using Mutagen.Bethesda;

namespace MEditService.Core.Serialization;

/// <summary>Where an embedded child's text sits inside its owner's document: the child's own span,
/// the slot member carrying it, and what the text says the child is.</summary>
internal readonly record struct EmbeddedChildSpan(
    int Start,
    int End,
    int SlotNameStart,
    int SlotValueEnd,
    bool SlotIsList,
    string? Discriminator,
    string SlotName,
    string? EditorId);

/// <summary>Finding a child inside its owner's document, keyed on the schema's slot facts and
/// reading nothing back as a live object. The one locator: a splice and a document read both ask
/// here.</summary>
internal static class EmbeddedChildLocator
{
    private const string FormKeyMember = "FormKey";

    private const string EditorIdMember = "EditorID";

    /// <summary>Written ahead of the fields for a slot whose element type is abstract, and the member
    /// a standalone document of an unambiguous type omits.</summary>
    internal const string DiscriminatorMember = "MutagenObjectType";

    /// <summary>The class name the owner's slots are keyed by: from the record type its path decides,
    /// or from the document's own discriminator when the path cannot name one.</summary>
    internal static string? ContainerTypeName(string? ownerRecordType, byte[] ownerBytes, GameRelease release) =>
        ownerRecordType is { } recordType
            ? RecordTypeDispatch.For(release).ConcreteFor(recordType)?.Name
            : RootDiscriminator(ownerBytes);

    /// <summary>Where <paramref name="formKey"/> sits inside <paramref name="ownerBytes"/>, or null
    /// when no child slot of the owner carries it. Malformed text carries nothing.</summary>
    internal static EmbeddedChildSpan? Find(
        byte[] ownerBytes, string? ownerTypeName, string formKey, GameRelease release)
    {
        try
        {
            var reader = new Utf8JsonReader(ownerBytes);
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject) return null;

            // The owner's own key is not a child of itself, so only what the scan found below it counts.
            return ScanObject(ref reader, ownerTypeName, formKey, ContainerSlots.For(release)).Deeper;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The type the document at its root declares, for a path that cannot name one.</summary>
    internal static string? RootDiscriminator(byte[] ownerBytes)
    {
        try
        {
            using var document = JsonDocument.Parse(ownerBytes);
            return document.RootElement.ValueKind == JsonValueKind.Object
                   && document.RootElement.TryGetProperty(DiscriminatorMember, out var value)
                   && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private readonly record struct ObjectScan(string? FormKey, string? Discriminator, string? EditorId, EmbeddedChildSpan? Deeper);

    // Enters on the object's '{' and leaves on its '}'.
    private static ObjectScan ScanObject(
        ref Utf8JsonReader reader, string? containerType, string formKey, ContainerSlots slots)
    {
        string? ownFormKey = null;
        string? discriminator = null;
        string? editorId = null;
        EmbeddedChildSpan? found = null;

        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            var member = reader.GetString()!;
            var memberStart = (int)reader.TokenStartIndex;
            reader.Read();

            if (reader.TokenType == JsonTokenType.String && member.Equals(FormKeyMember, StringComparison.Ordinal))
            {
                ownFormKey = reader.GetString();
                continue;
            }
            if (reader.TokenType == JsonTokenType.String && member.Equals(EditorIdMember, StringComparison.Ordinal))
            {
                editorId = reader.GetString();
                continue;
            }
            if (reader.TokenType == JsonTokenType.String && member.Equals(DiscriminatorMember, StringComparison.Ordinal))
            {
                discriminator = reader.GetString();
                containerType ??= discriminator;
                continue;
            }
            if (found != null || !slots.IsEmbeddedSlot(containerType, member))
            {
                reader.Skip();
                continue;
            }

            found = reader.TokenType switch
            {
                JsonTokenType.StartObject => InSingleSlot(ref reader, formKey, memberStart, member, slots),
                JsonTokenType.StartArray => InListSlot(ref reader, formKey, memberStart, member, slots),
                _ => null,
            };
        }

        return new ObjectScan(ownFormKey, discriminator, editorId, found);
    }

    // Enters on the slot value's '{' and leaves on its '}'.
    private static EmbeddedChildSpan? InSingleSlot(
        ref Utf8JsonReader reader, string formKey, int memberStart, string slotName, ContainerSlots slots)
    {
        var start = (int)reader.TokenStartIndex;
        var scan = ScanObject(ref reader, null, formKey, slots);
        var end = (int)reader.BytesConsumed;

        if (scan.Deeper is { } deeper) return deeper;

        return string.Equals(scan.FormKey, formKey, StringComparison.Ordinal)
            ? new EmbeddedChildSpan(start, end, memberStart, end, SlotIsList: false, scan.Discriminator, slotName, scan.EditorId)
            : null;
    }

    private const int PendingSlotEnd = -1;

    // Every element is walked even after a hit, so the reader leaves this slot on its ']'.
    private static EmbeddedChildSpan? InListSlot(
        ref Utf8JsonReader reader, string formKey, int memberStart, string slotName, ContainerSlots slots)
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

            found = scan.Deeper
                ?? (string.Equals(scan.FormKey, formKey, StringComparison.Ordinal)
                    ? new EmbeddedChildSpan(
                        start, end, memberStart, PendingSlotEnd, SlotIsList: true, scan.Discriminator, slotName, scan.EditorId)
                    : null);
        }

        // A hit from further down already names its own slot; only an element of this list waits for
        // where the list ends.
        return found is { SlotValueEnd: PendingSlotEnd } element
            ? element with { SlotValueEnd = (int)reader.BytesConsumed }
            : found;
    }
}
