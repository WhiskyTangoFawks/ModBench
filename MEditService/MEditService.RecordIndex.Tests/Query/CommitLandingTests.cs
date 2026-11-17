using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class CommitLandingTests : IDisposable
{
    private const string Master = "Master.esm";
    private const string Later = "Later.esp";
    private const string Checkpointed = "Checkpointed the record index";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("commit-landing")
        .WithPlugin(Master).WithPlugin(Later).Build();

    public void Dispose() => _fixture.Dispose();

    private static IEnumerable<PluginDocument> Items(string plugin) => Enumerable.Range(0, 20).Select(i =>
    {
        var formKey = $"{0x800 + i:X6}:{plugin}";
        return new PluginDocument("misc", formKey, $$"""{"FormKey": "{{formKey}}", "EditorID": "Item{{i}}", "Name": "x"}""");
    });

    private static bool IsQuiet(List<LogEntry> log)
    {
        int before;
        lock (log) before = log.Count;
        Thread.Sleep(TimeSpan.FromMilliseconds(500));
        lock (log) return log.Count == before;
    }

    private static bool Logged(List<LogEntry> log, string start)
    {
        lock (log) return log.Exists(e => e.Message.StartsWith(start, StringComparison.Ordinal));
    }

    [Fact]
    public async Task ACommitWhileAReadIsOpen_ReturnsWithoutACheckpoint_AndTheReadsEndPaysIt()
    {
        var log = new List<LogEntry>();
        using var loggers = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider(log)));
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, new MadeUpAdapter((Master, () => Items(Master)), (Later, () => Items(Later))), loggerFactory: loggers);
        index.Reconcile(holder, _fixture.DataFolder, [_fixture.Plugins[0]], GameRelease.Fallout4, _fixture.InstanceRoot);
        Waits.Reached(() => Logged(log, Checkpointed), "the first load's checkpoint");
        Waits.Reached(() => IsQuiet(log), "the first load's checkpoints");
        lock (log) log.Clear();
        IndexFiles.LogQueries(_fixture.InstanceRoot);
        using var left = new CancellationTokenSource();
        var slow = Task.Run(() => index.Queries.SelectRows(AbandonedReadTests.ForeverSelect, left.Token));
        InFlight();

        await Task.Run(() => index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot))
            .WaitAsync(TimeSpan.FromSeconds(30));

        Assert.False(Logged(log, Checkpointed));
        await left.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => slow);
        Waits.Reached(() => Logged(log, Checkpointed), "the checkpoint after the read ended");
    }

    [Fact]
    public void ACommitThatChangesNoRow_DoesNotApplyTheFilterAgain_AndOneThatDoesApplyIt()
    {
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, new MadeUpAdapter((Master, () => Items(Master)), (Later, () => Items(Later))));
        index.Reconcile(holder, _fixture.DataFolder, [_fixture.Plugins[0]], GameRelease.Fallout4, _fixture.InstanceRoot);
        index.SetFilter("SELECT form_key FROM records", "filter.sql");
        IndexFiles.LogQueries(_fixture.InstanceRoot);
        const string Materialized = "CREATE OR REPLACE TABLE _filter AS";

        index.SignalChange();
        Waits.Reached(() => IndexFiles.Started(_fixture.InstanceRoot, "SELECT plugin, origin, derived_from FROM"), "the check reading the index");
        Waits.Reached(() => index.Status is { Validating: false, State: LoadOrderState.Ready }, "the check ending");
        Assert.Equal(0, IndexFiles.StartedCount(_fixture.InstanceRoot, Materialized));

        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        Assert.True(IndexFiles.StartedCount(_fixture.InstanceRoot, Materialized) > 0);
    }

    [Fact]
    public async Task AFatalCheckpoint_ReopensTheStore_WithNoReadToMeetIt()
    {
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, new MadeUpAdapter((Master, () => Items(Master)), (Later, () => Items(Later))), notifications: notifications);
        index.Reconcile(holder, _fixture.DataFolder, [_fixture.Plugins[0]], GameRelease.Fallout4, _fixture.InstanceRoot);
        IndexFiles.LogQueries(_fixture.InstanceRoot);
        using var left = new CancellationTokenSource();
        var slow = Task.Run(() => index.Queries.SelectRows(AbandonedReadTests.ForeverSelect, left.Token));
        InFlight();
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        IndexFiles.Execute(_fixture.InstanceRoot, "SET GLOBAL debug_checkpoint_abort = 'before_header'");
        var before = notifications.Notifications.Count;

        await left.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => slow);

        Waits.Reached(
            () => notifications.Since(before).OfType<LoadOrderStatusNotification>().Any(n => n.Status.State == LoadOrderState.Reconciling),
            "the store reopening", TimeSpan.FromSeconds(30));
        Waits.Reached(() => index.Status.State == LoadOrderState.Ready && index.Queries.GetPlugins().Holds(out _, out _), "the reopened index");
    }

    private void InFlight() =>
        Waits.Reached(() => IndexFiles.Started(_fixture.InstanceRoot, "hash(a.range + b.range)"), "the slow read open");
}
