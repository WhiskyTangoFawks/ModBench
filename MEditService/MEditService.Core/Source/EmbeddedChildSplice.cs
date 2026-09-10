using System.Text;
using System.Text.Json;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Core.Source;

/// <summary>Where an embedded child's text sits inside its owner's document: the child's own span,
/// and the slot member carrying it, which a remove takes whole when the child was all it
/// held.</summary>
internal readonly record struct EmbeddedChildSpan(
    int Start, int End, int SlotNameStart, int SlotValueEnd, bool SlotIsList, string? Discriminator);

/// <summary>Reading, replacing and cutting an embedded child in its owner's JSON text. The owner is
/// never deserialized: these verbs change the child's span and no other byte of the text they are
/// handed.</summary>
internal static class EmbeddedChildSplice
{
    private const string FormKeyMember = "FormKey";

    // Written ahead of the fields for a slot whose element type is abstract, and the one member of an
    // embedded child's text a standalone document of an unambiguous type omits.
    private const string DiscriminatorMember = "MutagenObjectType";

    /// <summary>The class name the owner's slots are keyed by: from the record type its path decides,
    /// or from the document's own discriminator when the path cannot name one.</summary>
    internal static string? ContainerTypeName(string? ownerRecordType, byte[] ownerBytes, GameRelease release) =>
        ownerRecordType is { } recordType
            ? RecordTypeDispatch.For(release).ConcreteFor(recordType)?.Name
            : RootDiscriminator(ownerBytes);

    /// <summary>Where <paramref name="formKey"/> sits inside <paramref name="ownerBytes"/>, or null
    /// when no child slot of the owner carries it. Malformed text carries nothing.</summary>
    internal static EmbeddedChildSpan? Find(byte[] ownerBytes, string? ownerTypeName, string formKey)
    {
        try
        {
            var reader = new Utf8JsonReader(ownerBytes);
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject) return null;

            // The owner's own key is not a child of itself, so only what the scan found below it counts.
            return ScanObject(ref reader, ownerTypeName, formKey).Deeper;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The child's own text as the codec spells it standalone: the span de-indented, and
    /// without the discriminator a document of an unambiguous type carries none of.</summary>
    internal static string Extract(byte[] ownerBytes, EmbeddedChildSpan span, GameRelease release)
    {
        var text = DeIndent(
            Encoding.UTF8.GetString(ownerBytes, span.Start, span.End - span.Start), IndentAt(ownerBytes, span.Start));

        return span.Discriminator is { } named && !RecordTypeDispatch.For(release).IsPathAmbiguous(named)
            ? WithoutDiscriminator(text)
            : text;
    }

    /// <summary>The owner's text with <paramref name="childText"/> in the child's place, spelled as
    /// the slot carries it: indented to the span's column, and behind the discriminator the text it
    /// replaces carried.</summary>
    internal static string Replace(byte[] ownerBytes, EmbeddedChildSpan span, string childText)
    {
        var inline = Indent(
            WithDiscriminator(childText, span.Discriminator), IndentAt(ownerBytes, span.Start));

        return Encoding.UTF8.GetString(
            [.. ownerBytes[..span.Start], .. Encoding.UTF8.GetBytes(inline), .. ownerBytes[span.End..]]);
    }

    /// <summary>The owner's text without the child. The slot goes with it when the child was all it
    /// held, which is how the writer spells a cleared one: it emits neither an empty list nor a null
    /// member.</summary>
    internal static string Cut(byte[] ownerBytes, EmbeddedChildSpan span)
    {
        var (from, to) = span.SlotIsList && !IsOnlyElement(ownerBytes, span)
            ? WithoutItsSeparator(ownerBytes, span.Start, span.End)
            : WithoutItsSeparator(ownerBytes, span.SlotNameStart, span.SlotValueEnd);

        return Encoding.UTF8.GetString([.. ownerBytes[..from], .. ownerBytes[to..]]);
    }

    private static bool IsOnlyElement(byte[] bytes, EmbeddedChildSpan span) =>
        LastNonSpaceBefore(bytes, span.Start) is var opener && opener >= 0 && bytes[opener] == (byte)'['
        && FirstNonSpaceFrom(bytes, span.End) is var closer && closer >= 0 && bytes[closer] == (byte)']';

    // The comma on whichever side has one, so what is left is a list or an object that still parses.
    private static (int From, int To) WithoutItsSeparator(byte[] bytes, int start, int end)
    {
        var before = LastNonSpaceBefore(bytes, start);
        if (before >= 0 && bytes[before] == (byte)',') return (before, end);

        // Up to what follows the comma, not just past the comma: the indentation between the two
        // belongs to the sibling now taking this one's place.
        var after = FirstNonSpaceFrom(bytes, end);
        if (after >= 0 && bytes[after] == (byte)',')
            return (start, FirstNonSpaceFrom(bytes, after + 1) is var next && next >= 0 ? next : after + 1);

        return (before + 1, end);
    }

    private static int LastNonSpaceBefore(byte[] bytes, int at)
    {
        var back = at - 1;
        while (back >= 0 && char.IsWhiteSpace((char)bytes[back])) back--;
        return back;
    }

    private static int FirstNonSpaceFrom(byte[] bytes, int at)
    {
        var forward = at;
        while (forward < bytes.Length && char.IsWhiteSpace((char)bytes[forward])) forward++;
        return forward < bytes.Length ? forward : -1;
    }

    // Restored from the text being replaced: the slot's element type decides whether the writer emits
    // one, and the record keeping its FormKey keeps its class.
    private static string WithDiscriminator(string childText, string? discriminator)
    {
        if (discriminator is null) return childText;

        var bytes = Encoding.UTF8.GetBytes(childText);
        var reader = new Utf8JsonReader(bytes);
        reader.Read();
        if (!reader.Read() || reader.TokenType != JsonTokenType.PropertyName) return childText;
        if (reader.ValueTextEquals(DiscriminatorMember)) return childText;

        var at = (int)reader.TokenStartIndex;
        var declaration = Encoding.UTF8.GetBytes(
            $"\"{DiscriminatorMember}\": \"{discriminator}\",\n{new string(' ', IndentAt(bytes, at))}");
        return Encoding.UTF8.GetString([.. bytes[..at], .. declaration, .. bytes[at..]]);
    }

    private static readonly IReadOnlySet<(string ParentType, string Slot)> Slots = ContainerMembers.Derived.EmbeddedSlots;

    private static readonly HashSet<string> SlotNames = Slots.Select(slot => slot.Slot).ToHashSet(StringComparer.Ordinal);

    // A container whose text names no type of its own accepts any container's slot name, the latitude
    // EmbeddedChildPath takes for the same reason.
    private static bool IsChildSlot(string? containerType, string member) =>
        containerType is null ? SlotNames.Contains(member) : Slots.Contains((containerType, member));

    private readonly record struct ObjectScan(string? FormKey, string? Discriminator, EmbeddedChildSpan? Deeper);

    // Enters on the object's '{' and leaves on its '}'.
    private static ObjectScan ScanObject(ref Utf8JsonReader reader, string? containerType, string formKey)
    {
        string? ownFormKey = null;
        string? discriminator = null;
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
            if (reader.TokenType == JsonTokenType.String && member.Equals(DiscriminatorMember, StringComparison.Ordinal))
            {
                discriminator = reader.GetString();
                containerType ??= discriminator;
                continue;
            }
            if (found != null || !IsChildSlot(containerType, member))
            {
                reader.Skip();
                continue;
            }

            found = reader.TokenType switch
            {
                JsonTokenType.StartObject => InSingleSlot(ref reader, formKey, memberStart),
                JsonTokenType.StartArray => InListSlot(ref reader, formKey, memberStart),
                _ => null,
            };
        }

        return new ObjectScan(ownFormKey, discriminator, found);
    }

    // Enters on the slot value's '{' and leaves on its '}'.
    private static EmbeddedChildSpan? InSingleSlot(ref Utf8JsonReader reader, string formKey, int memberStart)
    {
        var start = (int)reader.TokenStartIndex;
        var scan = ScanObject(ref reader, null, formKey);
        var end = (int)reader.BytesConsumed;

        if (scan.Deeper is { } deeper) return deeper;

        return string.Equals(scan.FormKey, formKey, StringComparison.Ordinal)
            ? new EmbeddedChildSpan(start, end, memberStart, end, SlotIsList: false, scan.Discriminator)
            : null;
    }

    private const int PendingSlotEnd = -1;

    // Every element is walked even after a hit, so the reader leaves this slot on its ']'.
    private static EmbeddedChildSpan? InListSlot(ref Utf8JsonReader reader, string formKey, int memberStart)
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
            var scan = ScanObject(ref reader, null, formKey);
            var end = (int)reader.BytesConsumed;
            if (found != null) continue;

            found = scan.Deeper
                ?? (string.Equals(scan.FormKey, formKey, StringComparison.Ordinal)
                    ? new EmbeddedChildSpan(start, end, memberStart, PendingSlotEnd, SlotIsList: true, scan.Discriminator)
                    : null);
        }

        // A hit from further down already names its own slot; only an element of this list waits for
        // where the list ends.
        return found is { SlotValueEnd: PendingSlotEnd } element
            ? element with { SlotValueEnd = (int)reader.BytesConsumed }
            : found;
    }

    private static string? RootDiscriminator(byte[] ownerBytes)
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

    // Cut to the next member's own start, so the whitespace and comma between the two go with it.
    private static string WithoutDiscriminator(string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        var reader = new Utf8JsonReader(bytes);
        reader.Read();
        if (!reader.Read() || reader.TokenType != JsonTokenType.PropertyName) return text;

        var from = (int)reader.TokenStartIndex;
        reader.Read();
        var valueEnd = (int)reader.BytesConsumed;
        var to = reader.Read() && reader.TokenType == JsonTokenType.PropertyName
            ? (int)reader.TokenStartIndex
            : valueEnd;

        return Encoding.UTF8.GetString([.. bytes[..from], .. bytes[to..]]);
    }

    // Zero for a span something else wrote part-way along a line.
    private static int IndentAt(byte[] bytes, int start)
    {
        var spaces = 0;
        while (start - spaces - 1 >= 0 && bytes[start - spaces - 1] == (byte)' ') spaces++;
        return start - spaces - 1 >= 0 && bytes[start - spaces - 1] == (byte)'\n' ? spaces : 0;
    }

    private static string DeIndent(string text, int indent) =>
        indent == 0
            ? text
            : string.Join('\n', text.Split('\n').Select((line, at) => at == 0 ? line : WithoutLeadingSpaces(line, indent)));

    private static string Indent(string text, int indent) =>
        indent == 0
            ? text
            : string.Join('\n', text.Split('\n').Select((line, at) => at == 0 || line.Length == 0 ? line : new string(' ', indent) + line));

    private static string WithoutLeadingSpaces(string line, int spaces)
    {
        var at = 0;
        while (at < spaces && at < line.Length && line[at] == ' ') at++;
        return line[at..];
    }
}
