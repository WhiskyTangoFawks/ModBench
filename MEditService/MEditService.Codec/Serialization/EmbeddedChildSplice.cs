using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using Mutagen.Bethesda;

namespace MEditService.Codec.Serialization;

/// <summary>Replacing and cutting an embedded child in its owner's JSON text. The owner is never
/// deserialized: these verbs change the child's span and no other byte of the text they are
/// handed.</summary>
internal static class EmbeddedChildSplice
{
    /// <summary>The child's text for a caller holding the owner and asking by identity. Null when no
    /// embedded slot of the owner carries <paramref name="formKey"/>.</summary>
    internal static string? TextOf(byte[] ownerBytes, string? ownerRecordType, string formKey, GameRelease release) =>
        EmbeddedChildLocator.Find(ownerBytes, ownerRecordType, formKey, release) is { } span ? Extract(ownerBytes, span, release) : null;

    /// <summary>The child's own text as the codec spells it standalone: the span de-indented, and
    /// without the discriminator a document of an unambiguous type carries none of.</summary>
    internal static string Extract(byte[] ownerBytes, EmbeddedChildSpan span, GameRelease release)
    {
        var text = TextIndentation.Outdented(
            Encoding.UTF8.GetString(ownerBytes, span.Start, span.End - span.Start), TextIndentation.ColumnAt(ownerBytes, span.Start));

        return span.Discriminator is { } named && !RecordTypes.For(release).IsPathAmbiguous(named)
            ? WithoutDiscriminator(text)
            : text;
    }

    /// <summary>The owner's text with <paramref name="childText"/> in the child's place, spelled as
    /// the slot carries it: indented to the span's column, and behind the discriminator the text it
    /// replaces carried.</summary>
    internal static string Replace(byte[] ownerBytes, EmbeddedChildSpan span, string childText)
    {
        var inline = TextIndentation.Indented(
            WithDiscriminator(childText, span.Discriminator), TextIndentation.ColumnAt(ownerBytes, span.Start));

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
        if (reader.ValueTextEquals(LoquiUnions.UnionTypeDiscriminator)) return childText;

        var at = (int)reader.TokenStartIndex;
        var declaration = Encoding.UTF8.GetBytes(
            $"\"{LoquiUnions.UnionTypeDiscriminator}\": \"{discriminator}\",\n{new string(' ', TextIndentation.ColumnAt(bytes, at))}");
        return Encoding.UTF8.GetString([.. bytes[..at], .. declaration, .. bytes[at..]]);
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
}
