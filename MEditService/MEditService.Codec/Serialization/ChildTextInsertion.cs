using System.Text;
using System.Text.Json;

namespace MEditService.Codec.Serialization;

/// <summary>A container's text with one new child in a slot and no other byte changed. The child is spelled,
/// and sits, as the codec writes it.</summary>
internal static class ChildTextInsertion
{
    private readonly record struct Span(int Start, int End);

    private readonly record struct Member(string Name, Span Whole, Span Value, Span? LastElement);

    /// <summary><paramref name="text"/> with what <paramref name="canonical"/>, the codec's spelling of the
    /// container after the append, holds at the end of <paramref name="slot"/>.</summary>
    internal static string Inserted(string text, byte[] canonical, string slot)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        var canonicalMembers = RootMembers(canonical);
        var canonicalSlot = canonicalMembers.Single(member => member.Name == slot);
        var members = RootMembers(bytes);

        var (at, replacing, inserted) = members.FindIndex(member => member.Name == slot) is var held and >= 0
            ? IntoHeldSlot(bytes, members[held], canonical, canonicalSlot)
            : AsNewMember(bytes, members, canonical, canonicalMembers, canonicalSlot);
        return Encoding.UTF8.GetString([.. bytes[..at], .. Encoding.UTF8.GetBytes(inserted), .. bytes[(at + replacing)..]]);
    }

    private static (int At, int Replacing, string Inserted) IntoHeldSlot(byte[] bytes, Member held, byte[] canonical, Member canonicalSlot)
    {
        if (held.LastElement is { } last && canonicalSlot.LastElement is { } appended)
        {
            var column = IndentAt(bytes, last.Start);
            return (last.End, 0, $",\n{new string(' ', column)}{Respelled(canonical, appended, column)}");
        }

        // A slot the text spells empty or null takes the codec's whole value.
        return (held.Value.Start, held.Value.End - held.Value.Start, Respelled(canonical, canonicalSlot.Value, IndentAt(bytes, held.Whole.Start)));
    }

    // After the text's last member that the codec writes ahead of the slot. The FormKey always is: the codec
    // reads no record whose text does not open with it.
    private static (int At, int Replacing, string Inserted) AsNewMember(
        byte[] bytes, List<Member> members, byte[] canonical, List<Member> canonicalMembers, Member canonicalSlot)
    {
        var ahead = canonicalMembers.TakeWhile(member => member.Name != canonicalSlot.Name)
            .Select(member => member.Name).ToHashSet(StringComparer.Ordinal);
        var before = members.Last(member => ahead.Contains(member.Name));
        var column = IndentAt(bytes, before.Whole.Start);
        return (before.Whole.End, 0, $",\n{new string(' ', column)}{Respelled(canonical, canonicalSlot.Whole, column)}");
    }

    // Each line after the first moves from the codec's column to the text's.
    private static string Respelled(byte[] canonical, Span span, int column)
    {
        var canonicalColumn = IndentAt(canonical, span.Start);
        return string.Join('\n', Encoding.UTF8.GetString(canonical, span.Start, span.End - span.Start).Split('\n')
            .Select((line, at) => at == 0 || line.Length == 0
                ? line
                : new string(' ', column) + line[Math.Min(canonicalColumn, line.Length - line.TrimStart(' ').Length)..]));
    }

    private static int IndentAt(byte[] bytes, int at)
    {
        var lineStart = at;
        while (lineStart > 0 && bytes[lineStart - 1] != (byte)'\n') lineStart--;

        var spaces = 0;
        while (lineStart + spaces < at && bytes[lineStart + spaces] == (byte)' ') spaces++;
        return spaces;
    }

    private static List<Member> RootMembers(byte[] bytes)
    {
        var reader = new Utf8JsonReader(bytes);
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
