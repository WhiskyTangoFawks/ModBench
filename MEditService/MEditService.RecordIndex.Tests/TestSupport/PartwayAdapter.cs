using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Real documents, with <paramref name="atRecord"/> run when the ingest asks for the
/// record after the first <paramref name="afterRecords"/>, inside its write, and each record from
/// there on taking <paramref name="thenEachRecordTakes"/>.</summary>
internal sealed class PartwayAdapter(int afterRecords, Action atRecord, TimeSpan thenEachRecordTakes = default) : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings strings) =>
        base.OpenDocuments(modPath, loadOrder, schemas, strings).Map<IPluginDocuments, IPluginDocuments>(
            documents => new Partway(documents, afterRecords, atRecord, thenEachRecordTakes));

    private sealed class Partway(IPluginDocuments inner, int afterRecords, Action atRecord, TimeSpan thenEachRecordTakes) : IPluginDocuments
    {
        public PluginDocument Header => inner.Header;
        public IReadOnlyList<RecordTypeFailure> Failures => inner.Failures;

        public IEnumerable<PluginDocument> Records
        {
            get
            {
                var yielded = 0;
                foreach (var record in inner.Records)
                {
                    if (yielded == afterRecords) atRecord();
                    if (yielded++ >= afterRecords && thenEachRecordTakes > TimeSpan.Zero) Thread.Sleep(thenEachRecordTakes);
                    yield return record;
                }
            }
        }

        public void Dispose() => inner.Dispose();
    }
}
