using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>Real documents, with <paramref name="atRecord"/> run when the ingest asks for the
/// record after the first <paramref name="afterRecords"/>, inside its write.</summary>
internal sealed class PartwayAdapter(int afterRecords, Action atRecord) : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null) =>
        base.OpenDocuments(modPath, gameRelease, schemas, strings).Map<IPluginDocuments, IPluginDocuments>(
            documents => new Partway(documents, afterRecords, atRecord));

    private sealed class Partway(IPluginDocuments inner, int afterRecords, Action atRecord) : IPluginDocuments
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
                    if (yielded++ == afterRecords) atRecord();
                    yield return record;
                }
            }
        }

        public void Dispose() => inner.Dispose();
    }
}
