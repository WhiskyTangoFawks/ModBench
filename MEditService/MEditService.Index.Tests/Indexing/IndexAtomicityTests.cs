using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Indexing;

public class IndexAtomicityTests
{
    [Fact]
    public void Index_ThrowingPartway_CommitsNoPartialRows()
    {
        using var fixture = new PluginFixtureBuilder("index-atomicity")
            .WithPlugin("Atomic.esp", mod =>
            {
                mod.Npcs.AddNew("AtomicNPC1");
                mod.Npcs.AddNew("AtomicNPC2");
                mod.Npcs.AddNew("AtomicNPC3");
            })
            .Build();
        var key = new PluginAddress("Atomic.esp", "Data");
        using var index = Indexes.Reconciled(fixture, adapter: new PartwayAdapter(
            afterRecords: 2, () => throw new InvalidOperationException("injected mid-plugin read failure")));
        var reads = index.RequireReads();

        Assert.Contains(index.Status.Failures, f => f.Name == "Atomic.esp");
        Assert.DoesNotContain(index.Status.IndexedPlugins, p => p.Name == "Atomic.esp");
        Assert.Equal(0, reads.CountOf(key, "npc_"));
        Assert.Empty(reads.GetDocuments(key));
        Assert.Empty(reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10)).Items);
    }

    [Fact]
    public void Index_ReadWhenItLogsItsCommittedTimings_SeesEveryRecord()
    {
        using var fixture = new PluginFixtureBuilder("index-commit-visibility")
            .WithPlugin("Atomic.esp", mod =>
            {
                mod.Npcs.AddNew("AtomicNPC1");
                mod.Npcs.AddNew("AtomicNPC2");
            })
            .Build();
        var key = new PluginAddress("Atomic.esp", "Data");
        OpenedIndex? opened = null;
        int? npcsAtCommit = null;
        using var loggerFactory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Debug);
            b.AddProvider(new OnMessage("Index Atomic.esp:", () => npcsAtCommit = opened?.RequireReads().CountOf(key, "npc_")));
        });
        var holder = new LoadOrderHolder();
        using var index = opened = Indexes.Open(holder, loggerFactory: loggerFactory);

        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);

        Assert.Equal(2, npcsAtCommit);
    }

    private sealed class OnMessage(string prefix, Action action) : ILoggerProvider, ILogger
    {
        public ILogger CreateLogger(string categoryName) => this;
        public void Dispose() { }
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
            Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (formatter(state, exception).StartsWith(prefix, StringComparison.Ordinal)) action();
        }
    }
}
