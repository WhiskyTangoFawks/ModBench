using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.PluginAdapter;

/// <summary>One link cache over a whole load order, asked a set of FormKeys and answering names
/// (ADR-0005 rule 2): the cache and the records it holds never leave this file.</summary>
internal static class LoadOrderLinks
{
    internal static IReadOnlyDictionary<string, RecordLookupEntry> Targets(
        IPluginAdapter adapter,
        IReadOnlyList<ModPath> loadOrder,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        IReadOnlyCollection<string> formKeys)
    {
        var targets = new Dictionary<string, RecordLookupEntry>(StringComparer.OrdinalIgnoreCase);
        if (loadOrder.Count == 0 || formKeys.Count == 0) return targets;

        var opened = new List<ILoadedMod>(loadOrder.Count);
        try
        {
            foreach (var modPath in loadOrder)
            {
                // A file the load order names can be malformed or gone by now (ADR-0003), and a link
                // into a file nothing can read is unresolved.
                try { opened.Add(adapter.OpenForRead(modPath, gameRelease)); }
                catch (Exception ex) when (ex is not OutOfMemoryException) { /* answers nothing */ }
            }
            if (opened.Count == 0) return targets;

            using var cache = opened.Select(mod => mod.Getter).ToUntypedImmutableLinkCache();
            foreach (var formKey in formKeys)
            {
                // A malformed FormKey is an editor's raw input: it names nothing and throws nothing.
                if (!FormKey.TryFactory(formKey, out var parsed)) continue;
                if (!cache.TryResolve<IMajorRecordGetter>(parsed, out var record)) continue;
                targets[formKey] = new RecordLookupEntry(RecordTableName.Of(record, schemas), record.EditorID);
            }
            return targets;
        }
        finally
        {
            foreach (var mod in opened) mod.Dispose();
        }
    }
}
