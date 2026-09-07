using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>Which record a FormKey names in one plugin's working tree, for a caller holding no
/// identity. <see cref="SourceUnitResolver"/> runs the other way and cannot be asked without the
/// record type it looks for.</summary>
internal static class SourceIdentities
{
    /// <summary>What the tree holds at <paramref name="formKey"/>, or null when no document carries
    /// it. The record type comes from where the document sits and the EditorID from inside it, never
    /// a file name another tool renamed.</summary>
    internal static RecordIdentity? Of(
        string modFolder, string pluginFileName, FormKey formKey, GameRelease release)
    {
        var root = SourceDocuments.RootIn(modFolder, pluginFileName);
        if (!Directory.Exists(root)) return null;

        // The header's document is the fixed root RecordData.json, and its FormKey is computed rather
        // than declared, so no name in the tree carries it.
        var header = FormKey.Factory(PluginHeader.FormKeyFor(ModKey.FromFileName(pluginFileName)));
        if (formKey == header)
        {
            return File.Exists(Path.Combine(root, SourceUnitResolver.RecordDataFileName))
                ? new RecordIdentity(formKey.ToString(), PluginHeader.RecordType, null)
                : null;
        }

        // The canonical spelling throughout: names in the tree are the codec's, and a caller's raw
        // FormKey text can differ from them in hex case and in how it spells the plugin.
        var spelled = formKey.ToString();
        foreach (var entry in Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories))
        {
            if (!SourceUnitResolver.NameCarriesFormKey(Path.GetFileName(entry), spelled)) continue;

            // A directory whose name carries the FormKey holds the record in its RecordData.json; a
            // file whose name carries it is the record.
            var document = Directory.Exists(entry) ? Path.Combine(entry, SourceUnitResolver.RecordDataFileName) : entry;
            if (!File.Exists(document)) continue;
            if (EmbeddedOwners.RecordTypeOf(Path.GetRelativePath(modFolder, document), release) is not { } recordType)
                continue;

            // The name is the index; the document is the answer. A name the document contradicts is
            // stale, and the record it claims is elsewhere or gone.
            var (declared, editorId) = SourceDocuments.DeclaredBy(document, modFolder, pluginFileName);
            if (!FormKey.TryFactory(declared, out var declaredKey) || declaredKey != formKey) continue;

            return new RecordIdentity(spelled, recordType, editorId);
        }

        return null;
    }
}
