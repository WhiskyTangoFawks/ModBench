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

    private static byte[] RenamedDocument(string relativePath, byte[] bytes, ModKey from, ModKey to, bool isHeader)
    {
        var text = DocumentText.StripUtf8Bom(bytes);
        var bom = bytes[..^text.Length];
        return RecordDocumentEdits.TryWithPluginRenamed(text, isHeader, from, to, out var renamed, out var whyNot)
            ? [.. bom, .. renamed]
            : throw SourceStopException.Unreadable(new UnreadableFile(
                relativePath, $"'{relativePath}' in this plugin's source tree is no JSON document: {whyNot.TrimEnd('.')}."));
    }
}
