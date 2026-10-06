using System.Text.Encodings.Web;
using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>A plugin's source files as they read under another plugin name: the root, every leaf
/// name and every FormKey string of the plugin follow it, and the header's ModKey. Every other byte
/// stays.</summary>
internal static class PluginSourceRename
{
    private const string ModKeyMember = "ModKey";

    /// <summary><paramref name="relativePath"/>, a file of <paramref name="fromPlugin"/>'s source, as it
    /// reads in <paramref name="toPlugin"/>'s.</summary>
    internal static TreeFile Renamed(string relativePath, byte[] bytes, string fromPlugin, string toPlugin)
    {
        var (from, to) = (ModKey.FromFileName(fromPlugin), ModKey.FromFileName(toPlugin));
        var underRoot = Path.GetRelativePath(SourceRepositoryLayout.RootFor(fromPlugin), relativePath);
        var renamedPath = Path.Combine(
        [
            SourceRepositoryLayout.RootFor(toPlugin),
            .. underRoot.Split(Path.DirectorySeparatorChar).Select(leaf => SourceRepositoryLayout.LeafWithOrigin(leaf, from, to)),
        ]);
        return relativePath.EndsWith(SourceRepositoryLayout.JsonSuffix, StringComparison.OrdinalIgnoreCase)
            ? new TreeFile(renamedPath, RenamedDocument(relativePath, bytes, from, to))
            : new TreeFile(renamedPath, bytes);
    }

    private static byte[] RenamedDocument(string relativePath, byte[] bytes, ModKey from, ModKey to)
    {
        var text = DocumentText.StripUtf8Bom(bytes);
        var bom = bytes[..^text.Length];
        var isHeader = new LayoutPath(relativePath).IsHeaderDocument;
        var splices = new List<(int Start, int Length, byte[] Value)>();
        var reader = new Utf8JsonReader(text);
        var atModKey = false;
        try
        {
            while (reader.Read())
            {
                if (reader.TokenType == JsonTokenType.PropertyName)
                {
                    atModKey = isHeader && reader.CurrentDepth == 1 && reader.ValueTextEquals(ModKeyMember);
                    continue;
                }

                if (reader.TokenType == JsonTokenType.String
                    && RenamedValue(reader.GetString() ?? "", atModKey, from, to) is { } renamed)
                {
                    splices.Add(((int)reader.TokenStartIndex, reader.ValueSpan.Length + 2, JsonString(renamed)));
                }
                atModKey = false;
            }
        }
        catch (JsonException ex)
        {
            throw new UnreadableSourceDocumentException(new UnreadableFile(
                relativePath, $"'{relativePath}' in this plugin's source tree is no JSON document: {ex.Message.TrimEnd('.')}."));
        }

        return [.. bom, .. Spliced(text, splices)];
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
