using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class InvalidatedIndexFileTests : IDisposable
{
    private const string Before = "Before.esp";
    private const string Aborted = "Aborted.esp";
    private const string After = "After.esp";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("invalidated-index-file")
        .WithPlugin(Before, mod => mod.Npcs.AddNew("BeforeNpc"))
        .WithPlugin(Aborted, mod => mod.Npcs.AddNew("AbortedNpc"))
        .WithPlugin(After, mod => mod.Npcs.AddNew("AfterNpc"))
        .Build();

    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly OpenedIndex _index;

    public InvalidatedIndexFileTests()
    {
        _index = Indexes.Open(_holder, new AbortingDuckDbsCheckpointAtTheSecondRead(_fixture.InstanceRoot), notifications: _notifications);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var rewritten = new Fallout4Mod(ModKey.FromFileName(Aborted), Fallout4Release.Fallout4);
        rewritten.Npcs.AddNew("RewrittenNpc");
        rewritten.WriteToBinary(_fixture.Plugins.Single(p => p.Name == Aborted).Path);
        _index.NextSnapshotUnsettledUntil(() => _index.Status.State == LoadOrderState.Failed, "the validation failing");
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    [Fact]
    public void AFatalErrorInTheIndexFile_FailsTheSnapshotWithItsCause_AndBlamesNoPlugin()
    {
        var status = _index.Status;

        Assert.Empty(status.Failures);
        Assert.Contains("Checkpoint aborted", status.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheNextSnapshotAfterAFatalError_OpensTheIndexFileAgain_AndReadsEveryPlugin()
    {
        var before = _notifications.Notifications.Count;
        _index.NextSnapshotUnsettledUntil(() => Answered(before) is not null, "the snapshot's answer");

        Assert.Equal(LoadOrderState.Ready, Answered(before));
        Assert.Equal([Aborted, After, Before], _index.Status.IndexedPlugins.Select(p => p.Name).Order());
    }

    private LoadOrderState? Answered(int before) =>
        _notifications.Since(before).OfType<LoadOrderStatusNotification>()
            .Select(n => (LoadOrderState?)n.Status.State).LastOrDefault(state => state is LoadOrderState.Ready or LoadOrderState.Failed);

    private sealed class AbortingDuckDbsCheckpointAtTheSecondRead(string instanceRoot) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        private int _reads;

        private bool SecondRead() => Interlocked.Increment(ref _reads) == 2;

        public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
            ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings? strings = null)
        {
            var opened = base.OpenDocuments(modPath, loadOrder, schemas, strings);
            return modPath.ModKey.FileName == Aborted
                ? opened.Map<IPluginDocuments, IPluginDocuments>(documents => new AbortingDuckDbsNextCheckpointAfterTheRecords(documents, instanceRoot, SecondRead))
                : opened;
        }
    }

    private sealed class AbortingDuckDbsNextCheckpointAfterTheRecords(IPluginDocuments read, string instanceRoot, Func<bool> aborting) : IPluginDocuments
    {
        public PluginDocument Header => read.Header;

        public IReadOnlyList<RecordTypeFailure> Failures => read.Failures;

        public IEnumerable<PluginDocument> Records
        {
            get
            {
                foreach (var document in read.Records) yield return document;
                if (!aborting()) yield break;
                using var connection = new DuckDBConnection($"DataSource={IndexFiles.In(instanceRoot)}");
                connection.Open();
                using var command = connection.CreateCommand();
                command.CommandText = "SET GLOBAL checkpoint_threshold = '1KB'; SET GLOBAL debug_checkpoint_abort = 'before_header'";
                command.ExecuteNonQuery();
            }
        }

        public void Dispose() => read.Dispose();
    }
}
