using System.Runtime.CompilerServices;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Indexing;

public sealed class IngestRetentionTests : IDisposable
{
    private const string Plugin = "Streamed.esp";
    private const string Target = "000800:Streamed.esp";
    private const int MegabyteRecordCount = 160;
    private const int MegabyteEditorId = 1 << 20;
    private const int ReferringRecordCount = 2_000;
    private const string MemoryTheIngestsRowsOutgrow = "3MB";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("streamed-ingest").WithPlugin(Plugin).Build();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void APluginsIngest_LetsGoOfARecordItHasWritten_BeforeItReadsThePluginsLast()
    {
        using var documents = new MegabyteRecords();

        using var index = Indexes.Reconciled(_fixture, adapter: new StreamedAdapter(documents));

        Assert.Equal(MegabyteRecordCount, index.Queries.GetReferencesInActiveOrCompiledPlugins(Target).Value().Count);
        Assert.False(documents.FirstHeldAtTheLast);
    }

    [Fact]
    public void AfterAPluginsIngest_AReadAnswersInAMemoryLimitTheIngestsRowsOutgrow()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, new MadeUpAdapter((Plugin, ReferringRecords)));
        IndexFiles.Execute(_fixture.InstanceRoot, $"SET GLOBAL memory_limit = '{MemoryTheIngestsRowsOutgrow}'");

        Waits.Reached(() => index.Queries.GetReferencesInActiveOrCompiledPlugins(Target).Holds(out _, out _), "a read in the memory limit");
    }

    private static IEnumerable<PluginDocument> ReferringRecords()
    {
        for (var i = 1; i <= ReferringRecordCount; i++)
        {
            var formKey = $"{0x800 + i:X6}:{Plugin}";
            yield return new PluginDocument("npc_", formKey, $$"""{"FormKey": "{{formKey}}", "Keywords": ["{{Target}}"]}""");
        }
    }

    private sealed class StreamedAdapter(IPluginDocuments documents) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
            ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings strings) =>
            RequireExtensions.AnswerOf(() => documents);
    }

    private sealed class MegabyteRecords : IPluginDocuments
    {
        public bool? FirstHeldAtTheLast { get; private set; }

        public PluginDocument Header => new("header", $"000000:{Plugin}", "{}");

        public IReadOnlyList<RecordTypeFailure> Failures => [];

        public IEnumerable<PluginDocument> Records
        {
            get
            {
                var first = new WeakReference(null);
                for (var i = 0; i < MegabyteRecordCount; i++)
                {
                    if (i == MegabyteRecordCount - 1) FirstHeldAtTheLast = IsHeld(first);
                    var document = ReferringUnderAFormKeyBuiltAtRunTime(i);
                    if (i == 0) first.Target = document.FormKey;
                    yield return document;
                }
            }
        }

        private static PluginDocument ReferringUnderAFormKeyBuiltAtRunTime(int i)
        {
            var formKey = $"{0x900 + i:X6}:{Plugin}";
            return new PluginDocument(
                "npc_", formKey,
                $$"""{"FormKey": "{{formKey}}", "EditorID": "{{new string('E', MegabyteEditorId)}}", "Keywords": ["{{Target}}"]}""");
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static bool IsHeld(WeakReference weak)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            return weak.IsAlive;
        }

        public void Dispose()
        {
        }
    }
}
