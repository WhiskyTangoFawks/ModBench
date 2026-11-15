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
        lock (log) log.Clear();
        var rows = index.Queries.SelectRows("SELECT form_key FROM records").Value();
        using var taken = rows.Rows().GetEnumerator();
        Assert.True(taken.MoveNext());

        await Task.Run(() => index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot))
            .WaitAsync(TimeSpan.FromSeconds(30));

        Assert.False(Logged(log, Checkpointed));
        rows.Dispose();
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
}
