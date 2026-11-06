using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>A plugin's source files as they read under another plugin name: the root, every leaf
/// name and every FormKey string of the plugin follow it, and the header's ModKey. Every other byte
/// stays.</summary>
internal static class PluginSourceRename
{
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
            ? new TreeFile(renamedPath, RenamedDocument(relativePath, bytes, from, to, new LayoutPath(relativePath).IsHeaderDocument))
            : new TreeFile(renamedPath, bytes);
    }

    /// <summary><paramref name="bytes"/>, a document of another plugin's source, with each FormKey of
    /// <paramref name="fromPlugin"/> naming <paramref name="toPlugin"/>.</summary>
    internal static byte[] Following(string relativePath, byte[] bytes, string fromPlugin, string toPlugin) =>
        RenamedDocument(relativePath, bytes, ModKey.FromFileName(fromPlugin), ModKey.FromFileName(toPlugin), isHeader: false);

    /// <summary><paramref name="bytes"/>, a document of a plugin's source, with each string naming
    /// <paramref name="from"/> naming <paramref name="to"/>.</summary>
    internal static byte[] FollowingFormKeyChange(string relativePath, byte[] bytes, FormKey from, FormKey to) =>
        Spliced(relativePath, bytes, (byte[] text, out byte[]? changed, out string? whyNot) =>
            RecordDocumentEdits.TryWithFormKeyChanged(text, from, to, out changed, out whyNot));

    private static byte[] RenamedDocument(string relativePath, byte[] bytes, ModKey from, ModKey to, bool isHeader) =>
        Spliced(relativePath, bytes, (byte[] text, out byte[]? renamed, out string? whyNot) =>
            RecordDocumentEdits.TryWithPluginRenamed(text, isHeader, from, to, out renamed, out whyNot));

    private delegate bool Splice(byte[] text, out byte[]? spliced, out string? whyNot);

    private static byte[] Spliced(string relativePath, byte[] bytes, Splice splice)
    {
        var text = DocumentText.StripUtf8Bom(bytes);
        var bom = bytes[..^text.Length];
        return splice(text, out var spliced, out var whyNot) && spliced is not null
            ? [.. bom, .. spliced]
            : throw SourceStopException.Unreadable(new UnreadableFile(
                relativePath, $"'{relativePath}' in this plugin's source tree is no JSON document: {whyNot?.TrimEnd('.')}."));
    }
}
