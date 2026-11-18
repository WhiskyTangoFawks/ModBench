using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
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
        using var parked = new SemaphoreSlim(0);
        using var released = new SemaphoreSlim(0);
        using var loggers = LoggerFactory.Create(builder => builder.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider([], entry =>
        {
            if (!entry.Message.StartsWith("Created the record type views", StringComparison.Ordinal)) return;
            parked.Release();
            released.Wait(CreationHeldAtMost);
        })));
        using var fixture = new PluginFixtureBuilder("lazy-views-cancelled").WithPlugin(Plugin.Name, mod => mod.Npcs.AddNew("LazyNpc")).Build();
        using var index = Indexes.Reconciled(fixture, loggerFactory: loggers);
        var creating = Task.Run(() => index.Queries.SelectRows("SELECT 1", CancellationToken.None));
        try
        {
            Assert.True(await parked.WaitAsync(Patience), "the first SELECT creating the views");
            using var cancel = new CancellationTokenSource();
            var waiting = Task.Run(() => index.Queries.SelectRows("SELECT 1", cancel.Token));
            await Task.Delay(TimeSpan.FromSeconds(0.5));
            Assert.False(waiting.IsCompleted, "The second SELECT answered while the first was creating the views.");

            await cancel.CancelAsync();

            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting.WaitAsync(Patience));
        }
        finally
        {
            released.Release();
        }
        (await creating).Value().Dispose();
    }
}
