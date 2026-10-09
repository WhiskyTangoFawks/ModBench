using System.Text.Encodings.Web;
using System.Text.Json;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Serialization;

internal static class PluginRenameSplice
{
    internal static byte[] Apply(byte[] text, bool isHeader, ModKey from, ModKey to)
    {
        var splices = new List<(int Start, int Length, byte[] Value)>();
        var reader = new Utf8JsonReader(text);
        var atModKey = false;
        while (reader.Read())
        {
            if (reader.TokenType == JsonTokenType.PropertyName)
            {
                atModKey = isHeader && reader.CurrentDepth == 1 && reader.ValueTextEquals(RecordMembers.ModKey);
                continue;
            }

            if (reader.TokenType == JsonTokenType.String
                && RenamedValue(reader.GetString() ?? "", atModKey, from, to) is { } renamed)
            {
                splices.Add(((int)reader.TokenStartIndex, reader.ValueSpan.Length + 2, JsonString(renamed)));
            }
            atModKey = false;
        }
        return Spliced(text, splices);
    }

    private static string? RenamedValue(string value, bool atModKey, ModKey from, ModKey to)
    {
        if (atModKey) return ModKey.TryFromFileName(value, out var modKey) && modKey == from ? to.FileName.String : null;
        return FormKey.TryFactory(value, out var formKey) && formKey.ModKey == from ? new FormKey(to, formKey.ID).ToString() : null;
    }

    private static byte[] JsonString(string value) =>
        [(byte)'"', .. JsonEncodedText.Encode(value, JavaScriptEncoder.UnsafeRelaxedJsonEscaping).EncodedUtf8Bytes, (byte)'"'];

    private static byte[] Spliced(byte[] text, List<(int Start, int Length, byte[] Value)> splices)
    {
        var result = new List<byte>(text.Length);
        var at = 0;
        foreach (var (start, length, value) in splices)
        {
            result.AddRange(text.AsSpan(at, start - at));
            result.AddRange(value);
            at = start + length;
        }
        result.AddRange(text.AsSpan(at));
        return [.. result];
    }
}
