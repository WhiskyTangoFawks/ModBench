using System.Globalization;
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

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("streamed-ingest").WithPlugin(Plugin).Build();

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void APluginsIngest_LetsGoOfARecordItHasWritten_BeforeItReadsThePluginsLast()
    {
        using var documents = new MegabyteRecords(fileIndexedUnder: null);

        using var index = Indexes.Reconciled(_fixture, adapter: new StreamedAdapter(documents));

        Assert.Equal(MegabyteRecordCount, index.Queries.GetReferences(Target).Value().Count);
        Assert.False(documents.FirstHeldAtTheLast);
    }

    [Fact]
    public void APluginsIngest_HandsDuckDbTheRecordsItHasWritten_BeforeItReadsThePluginsLast()
    {
        using var documents = new MegabyteRecords(_fixture.InstanceRoot);

        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, adapter: new StreamedAdapter(documents));

        Assert.InRange(documents.DuckDbBytesAtTheLast, 16L * MegabyteEditorId, long.MaxValue);
    }

    [Fact]
    public void APluginsIngest_LeavesNoIndexNodesInDuckDbsMemory()
    {
        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot);

        Assert.Equal(
            ["0"],
            Assert.Single(IndexFiles.Rows(
                _fixture.InstanceRoot,
                "SELECT coalesce(sum(memory_usage_bytes), 0)::BIGINT FROM duckdb_memory() WHERE tag = 'ART_INDEX'")));
    }

    private sealed class StreamedAdapter(IPluginDocuments documents) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
            ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings strings) =>
            RequireExtensions.AnswerOf(() => documents);
    }

    private sealed class MegabyteRecords(string? fileIndexedUnder) : IPluginDocuments
    {
        public bool? FirstHeldAtTheLast { get; private set; }

        public long DuckDbBytesAtTheLast { get; private set; }

        public PluginDocument Header => new("header", $"000000:{Plugin}", "{}");

        public IReadOnlyList<RecordTypeFailure> Failures => [];

        public IEnumerable<PluginDocument> Records
        {
            get
            {
                var first = new WeakReference(null);
                for (var i = 0; i < MegabyteRecordCount; i++)
                {
                    if (i == MegabyteRecordCount - 1)
                    {
                        FirstHeldAtTheLast = IsHeld(first);
                        if (fileIndexedUnder is { } root) DuckDbBytesAtTheLast = DuckDbBytes(root);
                    }
                    var document = ReferringUnderAFormKeyBuiltAtRunTime(i);
                    if (i == 0) first.Target = document.FormKey;
                    yield return document;
                }
            }
        }

        private static long DuckDbBytes(string instanceRoot) =>
            long.Parse(
                Assert.Single(IndexFiles.Rows(instanceRoot, "SELECT sum(memory_usage_bytes)::BIGINT FROM duckdb_memory()"))[0],
                CultureInfo.InvariantCulture);

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
