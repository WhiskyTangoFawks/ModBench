using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using MEditService.Codec.Schema;

namespace MEditService.Codec.Serialization;

/// <summary>A malformed record's document in decompile and repair's first commit: its diagnoses, and as its subrecords'
/// bytes each field no reader proves.</summary>
public static class FlaggedDocument
{
    private const string Diagnoses = "Diagnoses";
    private const string Subrecords = "Subrecords";

    private static readonly string[] ReadBeforeAnyField = [LoquiUnions.UnionTypeDiscriminator, RecordMembers.FormKey, RecordMembers.EditorId];

    private static readonly JsonWriterOptions Indented = new() { Indented = true, NewLine = "\n", Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>The record whose own text is <paramref name="recordText"/> with no field proven: the members read before
    /// any field, then its diagnoses and every subrecord's bytes.</summary>
    public static string For(
        string recordText, IReadOnlyList<string> diagnoses, IEnumerable<(string Signature, ReadOnlyMemory<byte> Payload)> subrecords) =>
        Written(writer =>
        {
            writer.WriteStartObject();
            foreach (var member in ReadBeforeAnyField)
            {
                if (DocumentTokens.RootStringIn(recordText, member) is { } value) writer.WriteString(member, value);
            }
            WriteDiagnoses(writer, diagnoses);
            WriteSubrecords(writer, subrecords);
            writer.WriteEndObject();
        });

    /// <summary><paramref name="recordText"/> with each member of <paramref name="held"/> holding its subrecords' bytes in
    /// place of its value, and its diagnoses after its last member; every other byte as it was.</summary>
    public static string WithMembersHeldRaw(
        string recordText, IReadOnlyList<string> diagnoses,
        IReadOnlyDictionary<string, IReadOnlyList<(string Signature, ReadOnlyMemory<byte> Payload)>> held)
    {
        var bytes = Encoding.UTF8.GetBytes(recordText);
        var members = RootMembers(bytes);
        var last = members[^1];
        var column = TextIndentation.ColumnAt(bytes, members[0].NameStart);
        var diagnosesText = Written(writer =>
        {
            writer.WriteStartObject();
            WriteDiagnoses(writer, diagnoses);
            writer.WriteEndObject();
        });
        var text = Spliced(bytes, last.ValueEnd, last.ValueEnd,
            $",\n{new string(' ', column)}{TextIndentation.Indented(InnerMembersOf(diagnosesText), column)}");

        // From the last, so the offsets read before each splice still stand.
        foreach (var member in members.Where(member => held.ContainsKey(member.Name)).Reverse())
        {
            var raw = Written(writer =>
            {
                writer.WriteStartObject();
                WriteSubrecords(writer, held[member.Name]);
                writer.WriteEndObject();
            });
            text = Spliced(text, member.ValueStart, member.ValueEnd, TextIndentation.Indented(raw, column));
        }
        return Encoding.UTF8.GetString(text);
    }

    private static byte[] Spliced(byte[] bytes, int from, int to, string text) => [.. bytes[..from], .. Encoding.UTF8.GetBytes(text), .. bytes[to..]];

    /// <summary>The members of the record's own text, in order.</summary>
    public static IReadOnlyList<string> MembersOf(string recordText) => [.. RootMembers(Encoding.UTF8.GetBytes(recordText)).Select(member => member.Name)];

    /// <summary><paramref name="recordText"/> without <paramref name="member"/>, every other byte as it was.</summary>
    public static string WithoutMember(string recordText, string member) => EmbeddedChildSplice.CutSlots(recordText, [member]);

    private readonly record struct RootMember(string Name, int NameStart, int ValueStart, int ValueEnd);

    private static List<RootMember> RootMembers(byte[] bytes)
    {
        var members = new List<RootMember>();
        var reader = new Utf8JsonReader(bytes);
        reader.Read();
        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            var name = reader.GetString() ?? throw new InvalidOperationException("Expected a JSON property name to read a non-null string.");
            var nameStart = (int)reader.TokenStartIndex;
            reader.Read();
            var valueStart = (int)reader.TokenStartIndex;
            reader.Skip();
            members.Add(new RootMember(name, nameStart, valueStart, (int)reader.BytesConsumed));
        }
        return members;
    }

    private static string InnerMembersOf(string writtenObject) =>
        string.Join('\n', writtenObject.Split('\n')[1..^1].Select(line => line[2..]));

    private static void WriteDiagnoses(Utf8JsonWriter writer, IReadOnlyList<string> diagnoses)
    {
        writer.WriteStartArray(Diagnoses);
        foreach (var diagnosis in diagnoses) writer.WriteStringValue(diagnosis);
        writer.WriteEndArray();
    }

    private static void WriteSubrecords(Utf8JsonWriter writer, IEnumerable<(string Signature, ReadOnlyMemory<byte> Payload)> subrecords)
    {
        writer.WriteStartArray(Subrecords);
        foreach (var (signature, payload) in subrecords)
        {
            writer.WriteStartObject();
            writer.WriteString(signature, ByteSliceHex.ToHex(payload.Span));
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
    }

    private static string Written(Action<Utf8JsonWriter> write)
    {
        using var text = new MemoryStream();
        using (var writer = new Utf8JsonWriter(text, Indented)) write(writer);
        return Encoding.UTF8.GetString(text.ToArray());
    }
}
