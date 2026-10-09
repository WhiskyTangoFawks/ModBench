using System.Text;
using System.Text.Json;

namespace MEditService.Codec.Serialization;

/// <summary>A container's text with one new child in a slot and no other byte changed. The child is spelled,
/// and sits, as the codec writes it.</summary>
internal static class ChildTextInsertion
{
    private static readonly JsonReaderOptions AsNewtonsoftReads = new() { AllowTrailingCommas = true };

    private readonly record struct Span(int Start, int End);

    private readonly record struct Member(string Name, Span Whole, Span Value, Span? LastElement);

    private readonly record struct Insertion(int At, int Replacing, string Text);

    /// <summary><paramref name="text"/> with what <paramref name="canonical"/>, the codec's spelling of the
    /// container after the append, holds at the end of <paramref name="slot"/>.</summary>
    internal static string Inserted(string text, byte[] canonical, string slot)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        var canonicalMembers = RootMembers(canonical);
        var canonicalSlot = canonicalMembers.Single(member => member.Name == slot);
        var members = RootMembers(bytes);

        var insertion = members.Where(member => member.Name == slot).ToList() switch
        {
            [] => AfterTheLastMemberWrittenAhead(bytes, members, canonical, canonicalMembers, canonicalSlot),
            [{ LastElement: { } last }] when canonicalSlot.LastElement is { } appended => AfterTheLastElement(bytes, last, canonical, appended),
            [var empty] => AsTheWholeValue(bytes, empty, canonical, canonicalSlot),
            _ => throw new InvalidOperationException(
                $"The container's text names {slot} more than once, so which of them the record holds is not certain."),
        };
        var lineEnding = text.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        return Encoding.UTF8.GetString(
            [.. bytes[..insertion.At], .. Encoding.UTF8.GetBytes(insertion.Text.ReplaceLineEndings(lineEnding)), .. bytes[(insertion.At + insertion.Replacing)..]]);
    }

    private static Insertion AfterTheLastElement(byte[] bytes, Span last, byte[] canonical, Span appended)
    {
        var column = TextIndentation.ColumnAt(bytes, last.Start);
        return new(last.End, 0, $",\n{new string(' ', column)}{AtColumn(canonical, appended, column)}");
    }

    private static Insertion AsTheWholeValue(byte[] bytes, Member empty, byte[] canonical, Member canonicalSlot) =>
        new(empty.Value.Start, empty.Value.End - empty.Value.Start,
            AtColumn(canonical, canonicalSlot.Value, TextIndentation.ColumnAt(bytes, empty.Whole.Start)));

    // The FormKey is always one of them: the codec reads no record whose text does not open with it.
    private static Insertion AfterTheLastMemberWrittenAhead(
        byte[] bytes, List<Member> members, byte[] canonical, List<Member> canonicalMembers, Member canonicalSlot)
    {
        var ahead = canonicalMembers.TakeWhile(member => member.Name != canonicalSlot.Name)
            .Select(member => member.Name).ToHashSet(StringComparer.Ordinal);
        var before = members.Last(member => ahead.Contains(member.Name));
        var column = TextIndentation.ColumnAt(bytes, before.Whole.Start);
        return new(before.Whole.End, 0, $",\n{new string(' ', column)}{AtColumn(canonical, canonicalSlot.Whole, column)}");
    }

    private static string AtColumn(byte[] canonical, Span span, int column) =>
        TextIndentation.Indented(
            TextIndentation.Outdented(
                Encoding.UTF8.GetString(canonical, span.Start, span.End - span.Start), TextIndentation.ColumnAt(canonical, span.Start)),
            column);

    private static List<Member> RootMembers(byte[] bytes)
    {
        var reader = new Utf8JsonReader(bytes, AsNewtonsoftReads);
        reader.Read();
        var members = new List<Member>();
        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            var name = reader.GetString() ?? throw new InvalidOperationException("Expected a JSON property name to read a non-null string.");
            var nameStart = (int)reader.TokenStartIndex;
            reader.Read();
            var valueStart = (int)reader.TokenStartIndex;
            Span? last = null;
            if (reader.TokenType == JsonTokenType.StartArray)
            {
                while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
                {
                    var start = (int)reader.TokenStartIndex;
                    reader.Skip();
                    last = new Span(start, (int)reader.BytesConsumed);
                }
            }
            else
            {
                reader.Skip();
            }
            var end = (int)reader.BytesConsumed;
            members.Add(new Member(name, new Span(nameStart, end), new Span(valueStart, end), last));
        }
        return members;
    }
}
