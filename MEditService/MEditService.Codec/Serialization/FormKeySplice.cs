using System.Text.Encodings.Web;
using System.Text.Json;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Serialization;

internal static class FormKeySplice
{
    internal static byte[] PluginRenamed(byte[] text, bool isHeader, ModKey from, ModKey to) =>
        Apply(text, isHeader, (value, atModKey) =>
        {
            if (atModKey) return ModKey.TryFromFileName(value, out var modKey) && modKey == from ? to.FileName.String : null;
            return FormKey.TryFactory(value, out var formKey) && formKey.ModKey == from ? new FormKey(to, formKey.ID).ToString() : null;
        });

    internal static byte[] FormKeyChanged(byte[] text, FormKey from, FormKey to) =>
        Apply(text, isHeader: false, (value, _) => FormKey.TryFactory(value, out var formKey) && formKey == from ? to.ToString() : null);

    private static byte[] Apply(byte[] text, bool isHeader, Func<string, bool, string?> spliced)
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

            if (reader.TokenType == JsonTokenType.String && spliced(reader.GetString() ?? "", atModKey) is { } value)
            {
                splices.Add(((int)reader.TokenStartIndex, reader.ValueSpan.Length + 2, JsonString(value)));
            }
            atModKey = false;
        }
        return Spliced(text, splices);
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
