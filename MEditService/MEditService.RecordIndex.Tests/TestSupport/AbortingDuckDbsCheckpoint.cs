using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Reads <paramref name="plugin"/> as the real adapter does, and on its <paramref name="nthRead"/>
/// leaves DuckDB to abort its next checkpoint.</summary>
internal sealed class AbortingDuckDbsCheckpoint(string instanceRoot, string plugin, int nthRead) : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    private int _reads;

    public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings strings)
    {
        var opened = base.OpenDocuments(modPath, loadOrder, schemas, strings);
        return modPath.ModKey.FileName == plugin
            ? opened.Map<IPluginDocuments, IPluginDocuments>(documents => new AbortingNextCheckpointAfterTheRecords(documents, instanceRoot, () => Interlocked.Increment(ref _reads) == nthRead))
            : opened;
    }

    private sealed class AbortingNextCheckpointAfterTheRecords(IPluginDocuments read, string instanceRoot, Func<bool> aborting) : IPluginDocuments
    {
        public PluginDocument Header => read.Header;

        public IReadOnlyList<RecordTypeFailure> Failures => read.Failures;

        public IEnumerable<PluginDocument> Records
        {
            get
            {
                foreach (var document in read.Records) yield return document;
                if (!aborting()) yield break;
                IndexFiles.AbortNextCheckpoint(instanceRoot);
            }
        }

        public void Dispose() => read.Dispose();
    }
}
