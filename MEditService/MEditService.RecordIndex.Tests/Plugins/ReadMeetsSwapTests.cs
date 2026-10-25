using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class ReadMeetsSwapTests : IDisposable
{
    private const string Plugin = "Swapped.esp";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("read-meets-swap")
        .WithPlugin(Plugin, mod => mod.Npcs.AddNew("SwappedNpc"))
        .Build();

    private readonly LoadOrderHolder _holder = new();
    private readonly ParkingSource _source = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly OpenedIndex _index;

    public ReadMeetsSwapTests()
    {
        _index = Indexes.Open(_holder, source: _source, notifications: _notifications);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _source.Dispose();
        _fixture.Dispose();
    }

    [Fact]
    public async Task ARead_WhoseStoreIsRebuiltBeforeItOpensAConnection_IsNotReady()
    {
        var copy = new RecordCopy("000800:Swapped.esp", _fixture.Plugins.Single().Key, DocumentText: "{}");
        _source.ParkNextTreeLookup();
        var read = Task.Run(() => _index.Queries.GetCompareRecords([copy]));
        await _source.WaitUntilParkedAsync();
        Assert.Null(_index.Queries.RebuildStore(GameRelease.Fallout4, _fixture.InstanceRoot));

        _source.Release();

        Assert.Equal(IndexRefusal.IndexNotReady, (await read).Refused().Refusal);
    }

    [Fact]
    public void ARead_OfAnIndexFileDuckDbInvalidated_IsNotReady_AndSaysItWasInvalidated()
    {
        IndexFiles.AbortNextCheckpoint(_fixture.InstanceRoot);
        Assert.Throws<DuckDB.NET.Data.DuckDBException>(() =>
            IndexFiles.Execute(_fixture.InstanceRoot, "CREATE TABLE aborts_the_checkpoint AS SELECT range AS n FROM range(100000)"));

        var refused = _index.Queries.GetPlugins().Refused();

        Assert.Equal(IndexRefusal.IndexNotReady, refused.Refusal);
        Assert.Contains("invalidated", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ARead_OfAnIndexFileDuckDbInvalidated_ReopensTheIndex_ReportsItReconcilingMeanwhile_AndAnswersAgain()
    {
        IndexFiles.AbortNextCheckpoint(_fixture.InstanceRoot);
        Assert.Throws<DuckDB.NET.Data.DuckDBException>(() =>
            IndexFiles.Execute(_fixture.InstanceRoot, "CREATE TABLE aborts_the_checkpoint AS SELECT range AS n FROM range(100000)"));
        var statusesBefore = _notifications.Notifications.Count;

        var refused = _index.Queries.GetPlugins().Refused();

        Assert.Equal(IndexRefusal.IndexNotReady, refused.Refusal);
        Assert.Contains("invalidated", refused.Message, StringComparison.Ordinal);
        Waits.Reached(() => _index.Status.State == LoadOrderState.Ready && _index.Queries.GetPlugins().Holds(out _, out _), "the reopened index");
        Assert.Contains(LoadOrderState.Reconciling, _notifications.Notifications.Skip(statusesBefore)
            .OfType<LoadOrderStatusNotification>().Select(n => n.Status.State));
        Assert.NotEmpty(_index.ListedIn(_fixture.Plugins.Single().Key));
    }
}
