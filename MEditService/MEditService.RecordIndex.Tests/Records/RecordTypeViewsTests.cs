using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class RecordTypeViewsTests
{
    private static readonly PluginAddress Plugin = new("Lazy.esp", PluginOrigin.DataDirectory);
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan CreationHeldAtMost = TimeSpan.FromMinutes(1);

    [Fact]
    public void EveryTypedRead_AnswersBeforeAnyFilter_AndAFilterNamingARecordTypeStillNarrows()
    {
        FormKey npcKey = default;
        using var fixture = new PluginFixtureBuilder("lazy-views")
            .WithPlugin(Plugin.Name, mod => npcKey = mod.Npcs.AddNew("LazyNpc").FormKey)
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var npc = npcKey.ToString();
        IReadOnlyList<RecordSummary> Listed() =>
            index.Queries.GetRecords(types: null, Plugin, search: null, limit: 10, offset: 0).Value().Items;

        Assert.Equal("LazyNpc", (index.Queries.GetWinner(npc).Value()
            ?? throw new InvalidOperationException($"Expected a document for '{npc}'.")).EditorId);
        Assert.Equal("LazyNpc", index.DocumentOf(npc, Plugin).EditorId);
        Assert.Contains(Listed(), i => i.FormKey == npc);
        Assert.Equal("npc_", index.ResolutionOf(npc, Plugin, npc).RecordType);
        Assert.Contains(index.Queries.GetPluginRecordTypes(Plugin).Value(), c => c.Type == "npc_" && c.Count == 1);

        index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'LazyNpc'", "filter.sql");

        Assert.Contains(Listed(), i => i.FormKey == npc);
        index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'NobodyHere'", "filter.sql");
        Assert.Empty(Listed());
    }

    [Fact]
    public async Task ASelectWaitingWhileAnotherCreatesTheViews_StopsAtItsCancellation()
    {
        using var creation = new FirstSelectParkedCreatingTheViews("lazy-views-cancelled");
        await creation.Parked();
        using var cancel = new CancellationTokenSource();
        var waiting = await creation.SecondSelectSeenWaiting(cancel.Token);

        await cancel.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting.WaitAsync(Patience));
        creation.Release();
        (await creation.Creating).Value().Dispose();
    }

    [Fact]
    public async Task ASelectWaitingWhileAnotherCreatesTheViews_IsNotReadyWhenTheIndexCloses()
    {
        using var creation = new FirstSelectParkedCreatingTheViews("lazy-views-closed");
        await creation.Parked();
        var waiting = await creation.SecondSelectSeenWaiting(CancellationToken.None);

        var closing = Task.Run(creation.Index.Dispose);

        Assert.Equal(IndexRefusal.IndexNotReady, (await waiting.WaitAsync(Patience)).Refused().Refusal);
        creation.Release();
        await closing.WaitAsync(Patience);
    }

    private sealed class FirstSelectParkedCreatingTheViews : IDisposable
    {
        private readonly SemaphoreSlim _parked = new(0);
        private readonly SemaphoreSlim _released = new(0);
        private readonly ILoggerFactory _loggers;
        private readonly PluginFixtureData _fixture;

        public FirstSelectParkedCreatingTheViews(string name)
        {
            _loggers = LoggerFactory.Create(builder => builder.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider([], entry =>
            {
                if (!entry.Message.StartsWith("Created the record type views", StringComparison.Ordinal)) return;
                _parked.Release();
                Waits.Signalled(_released.Wait, "the release of the views' creation", CreationHeldAtMost);
            })));
            _fixture = new PluginFixtureBuilder(name).WithPlugin(Plugin.Name, mod => mod.Npcs.AddNew("LazyNpc")).Build();
            Index = Indexes.Reconciled(_fixture, loggerFactory: _loggers);
            Creating = Task.Run(() => Index.Queries.SelectRows("SELECT 1", CancellationToken.None));
        }

        public OpenedIndex Index { get; }

        public Task<Answer<SelectedRows, IndexRefused>> Creating { get; }

        public async Task Parked() => Assert.True(await _parked.WaitAsync(Patience), "the first SELECT creating the views");

        public async Task<Task<Answer<SelectedRows, IndexRefused>>> SecondSelectSeenWaiting(CancellationToken cancel)
        {
            var waiting = Task.Run(() => Index.Queries.SelectRows("SELECT 1", cancel));
            await Task.Delay(TimeSpan.FromMilliseconds(100), CancellationToken.None);
            Assert.False(waiting.IsCompleted, "The second SELECT answered while the first was creating the views.");
            return waiting;
        }

        public void Release() => _released.Release();

        public void Dispose()
        {
            Release();
            Index.Dispose();
            _fixture.Dispose();
            _loggers.Dispose();
            _parked.Dispose();
            _released.Dispose();
        }
    }
}
