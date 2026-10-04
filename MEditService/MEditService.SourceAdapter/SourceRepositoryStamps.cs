using System.Security.Cryptography;
using System.Text;
using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>Every document of a plugin's tree by the FormKey it declares, each with its content stamp,
/// and a line for each file that could not be read as one.</summary>
public sealed record RecordStamps(IReadOnlyDictionary<string, string> ByFormKey, IReadOnlyList<string> Unreadable);

/// <summary>A record's content stamp: what the index remembers of a document, and what the tree is
/// asked against (ADR-0003).</summary>
public sealed partial class SourceRepository
{
    /// <summary>The stamp of one document's UTF-8 bytes, equal for equal bytes and for no others.</summary>
    public static string ContentStamp(ReadOnlySpan<byte> body) => Convert.ToHexStringLower(SHA256.HashData(body));

    /// <summary>One listing of the plugin's tree, read from disk now. A FormKey two documents declare
    /// throws <see cref="AmbiguousSourceUnitException"/>.</summary>
    public RecordStamps StampsOf(PluginAddress plugin)
    {
        var unreadable = new List<string>();
        var filedAt = new Dictionary<string, string>(StringComparer.Ordinal);
        var stamps = new Dictionary<string, string>(StringComparer.Ordinal);

        var root = RootIn(_modFolder, plugin.Name);
        if (!Directory.Exists(root)) return new RecordStamps(stamps, unreadable);

        // Keyed by the FormKey the document declares, never by its path: a file name carries an
        // EditorID that may contain the separator, so a path is not a decidable identity.
        foreach (var file in Directory.EnumerateFiles(root, $"*{JsonSuffix}", SearchOption.AllDirectories))
        {
            if (CarriesNoRecord(file)) continue;

            byte[] bytes;
            try
            {
                bytes = StripUtf8Bom(File.ReadAllBytes(file));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Never exclusive owners of a file: it may vanish or lock between the listing and the
                // read. A skip and a line, and the tree stops counting as evidence a record is gone.
                unreadable.Add($"Could not read '{file}': {ex.Message}");
                continue;
            }

            if (FormKeyDeclaredIn(Encoding.UTF8.GetString(bytes), file, plugin.Name) is not { } formKey)
            {
                unreadable.Add($"'{file}' declares no FormKey, so the records it holds could not be validated.");
                continue;
            }

            OneDocumentPerFormKey.Claim(filedAt, formKey, file, _modFolder);
            stamps[formKey] = ContentStamp(bytes);
        }

        return new RecordStamps(stamps, unreadable);
    }
}
