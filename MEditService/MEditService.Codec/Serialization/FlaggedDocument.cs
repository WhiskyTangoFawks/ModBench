using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using MEditService.Codec.Schema;

namespace MEditService.Codec.Serialization;

/// <summary>A malformed record's document in decompile and repair's first commit. No field of a malformed record is
/// proven, so past the members read before any field it holds its diagnoses and each subrecord's bytes.</summary>
public static class FlaggedDocument
{
    private static readonly string[] ReadBeforeAnyField = [LoquiUnions.UnionTypeDiscriminator, RecordMembers.FormKey, RecordMembers.EditorId];

    /// <summary>The flagged document of the record whose own text is <paramref name="recordText"/>.</summary>
    public static string For(
        string recordText, IReadOnlyList<string> diagnoses, IEnumerable<(string Signature, ReadOnlyMemory<byte> Payload)> subrecords)
    {
        using var text = new MemoryStream();
        using (var writer = new Utf8JsonWriter(text, new JsonWriterOptions { Indented = true, NewLine = "\n", Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            writer.WriteStartObject();
            foreach (var member in ReadBeforeAnyField)
            {
                if (DocumentTokens.RootStringIn(recordText, member) is { } value) writer.WriteString(member, value);
            }
            writer.WriteStartArray("Diagnoses");
            foreach (var diagnosis in diagnoses) writer.WriteStringValue(diagnosis);
            writer.WriteEndArray();
            writer.WriteStartArray("Subrecords");
            foreach (var (signature, payload) in subrecords)
            {
                writer.WriteStartObject();
                writer.WriteString(signature, ByteSliceHex.ToHex(payload.Span));
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(text.ToArray());
    }
}
