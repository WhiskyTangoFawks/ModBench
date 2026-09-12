using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Plugins;

/// <summary>The Index's scope — the store it opens, the copies it holds open in it, and the filter
/// materialized over it — across a reconcile, a replacement, a close and a dispose.</summary>
[Collection(TestPluginFixtureCollection.Name)]
public class IndexScopeTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static IndexProjector MakeManager(LoadOrderHolder holder, IPluginAdapter? adapter = null)
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        return new IndexProjector(holder, adapter ?? MutagenPluginAdapter.Instance, factory);
    }

    // An explicit request for a release this build has no Mutagen assembly for must refuse with a
    // typed, actionable exception rather than a FileNotFoundException from inside Initialize.
    [Fact]
    public void Load_ForUnsupportedGameRelease_ThrowsUnsupportedGameReleaseException()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeManager(holder);

        var ex = Assert.Throws<UnsupportedGameReleaseException>(
            () => manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.SkyrimSE));

        Assert.Contains("SkyrimSE", ex.Message);
    }

    // Faulting UpdateWinners fails after IndexAndStore publishes, inside its own catch, and nothing
    // after this call touches state, so the assertions observe that catch's cleanup rather than a later
    // call masking it.
    [Fact]
    public void Reconcile_WhenUpdateWinnersFaults_LeavesWhatLandedHeldAndUnsettled()
    {
        var holder = new LoadOrderHolder();
        var data = new PluginFixtureBuilder("solo-mid-load-failure")
            .WithPlugin("Base.esp")
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            var faulting = new FaultingUpdateWinnersRepositoryFactory(inner);
            using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, faulting);

            Assert.Throws<InvalidOperationException>(() =>
                manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4));

            // ADR-0013: nothing is torn down — what landed stays held, honestly reported as not
            // yet settled, for the next snapshot to finish.
            Assert.NotNull(manager.Reads);
            Assert.Equal(LoadOrderState.Reconciling, manager.Status.State);
            Assert.False(manager.Status.ConflictsComputed);
        }
    }

    [Fact]
    public void Load_DelegatesToFactory()
    {
        var holder = new LoadOrderHolder();
        var reflector = SharedSchemaReflector.Instance;
        var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        var spy = new SpyRepositoryFactory(inner);
        using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, spy);

        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.Equal(1, spy.CreateCallCount);
        Assert.Equal(GameRelease.Fallout4, spy.LastGameRelease);
    }

    [Fact]
    public void Load_PopulatesLoadOrderAndRepository()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeManager(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.NotNull(manager.Reads);
        Assert.Equal(TestPluginFixture.PluginName, Assert.Single(manager.Reads!.OpenedCopies).Key.Name);
    }

    [Fact]
    public void Load_IndexesRecordsIntoRepository()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeManager(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        var count = manager.Reads!.GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data"))
            .FirstOrDefault(c => string.Equals(c.Type, "npc_", StringComparison.OrdinalIgnoreCase))?.Count ?? 0;

        Assert.Equal(TestPluginFixture.RecordCount, count);
    }

    [Fact]
    public void Load_SetsIsWinnerOnSinglePlugin()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeManager(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        var result = manager.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 100, Offset: 0));

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.True(r.IsWinner));
    }

    [Fact]
    public void Unload_ClearsReferencesAndDisposesRepository()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeManager(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var oldRepo = manager.Reads;
        manager.Close();

        Assert.Null(manager.Reads);
        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data")));
    }

    [Fact]
    public void Reconcile_SameInstance_KeepsTheStore()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeManager(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var firstRepo = manager.Reads;

        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        // ADR-0013: a snapshot for the same instance reconciles in place — nothing is replaced.
        Assert.Same(firstRepo, manager.Reads);
    }




    // --- SetFilter / ClearFilter ---

    [Fact]
    public void SetFilter_NoLoadOrder_ThrowsInvalidOperationException()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeManager(holder);
        var ex = Assert.Throws<NoLoadOrderException>(() => manager.SetFilter("SELECT form_key FROM \"NPC_\""));
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void ClearFilter_NoLoadOrder_ThrowsInvalidOperationException()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeManager(holder);
        var ex = Assert.Throws<NoLoadOrderException>(() => manager.ClearFilter());
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void SetFilter_ValidSql_SetsSqlOnLoadOrder()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeLoadedManager(holder);
        manager.SetFilter("SELECT form_key FROM \"NPC_\"");
        Assert.Equal("SELECT form_key FROM \"NPC_\"", manager.FilterSql);
    }

    [Fact]
    public void ClearFilter_AfterSetFilter_ClearsSqlOnLoadOrder()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeLoadedManager(holder);
        manager.SetFilter("SELECT form_key FROM \"NPC_\"");
        manager.ClearFilter();
        Assert.Null(manager.FilterSql);
    }

    // --- Filter re-materialization ---
    //
    // _filter is a one-shot snapshot of whatever matched the filter SQL when it ran, so every mutation
    // path that can change which records match has to re-run it.

    [Fact]
    public async Task ReindexPlugin_AfterBinaryChangeMakesARecordNewlyMatchTheFilter_FilteredListingIncludesIt()
    {
        var holder = new LoadOrderHolder();
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("reindex-filter-newly-matches")
            .WithPlugin("Plugin.esp", mod => npcKey = mod.Npcs.AddNew("NotMatchingYet").FormKey)
            .Build();
        using (data)
        {
            using var manager = MakeManager(holder);
            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);

            manager.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'NowMatches'");
            Assert.Equal(0, manager.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            var pluginPath = Path.Combine(data.DataFolder, "Plugin.esp");
            var onDisk = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName("Plugin.esp"), pluginPath), Fallout4Release.Fallout4);
            onDisk.Npcs.First(n => n.FormKey == npcKey).EditorID = "NowMatches";
            onDisk.WriteToBinary(pluginPath);

            var pluginKey = new PluginKey("Plugin.esp", data.Plugins.Single(p => p.Name == "Plugin.esp").Origin);
            await manager.ReindexPlugin(pluginKey);

            var result = manager.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(1, result.Total);
            Assert.Equal(npcKey.ToString(), result.Items[0].FormKey);
        }
    }

    [Fact]
    public async Task ReindexPlugin_AfterBinaryChangeMakesARecordStopMatchingTheFilter_FilteredListingExcludesIt()
    {
        var holder = new LoadOrderHolder();
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("reindex-filter-stops-matching")
            .WithPlugin("Plugin.esp", mod => npcKey = mod.Npcs.AddNew("StillMatches").FormKey)
            .Build();
        using (data)
        {
            using var manager = MakeManager(holder);
            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);

            manager.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'StillMatches'");
            Assert.Equal(1, manager.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            var pluginPath = Path.Combine(data.DataFolder, "Plugin.esp");
            var onDisk = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName("Plugin.esp"), pluginPath), Fallout4Release.Fallout4);
            onDisk.Npcs.First(n => n.FormKey == npcKey).EditorID = "NoLongerMatches";
            onDisk.WriteToBinary(pluginPath);

            var pluginKey = new PluginKey("Plugin.esp", data.Plugins.Single(p => p.Name == "Plugin.esp").Origin);
            await manager.ReindexPlugin(pluginKey);

            var result = manager.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(0, result.Total);
        }
    }


    [Fact]
    public async Task ReindexPlugin_WhenReapplyingTheFilterFaults_DoesNotThrow_AndLogsAWarningNamingTheException()
    {
        var holder = new LoadOrderHolder();
        var data = new PluginFixtureBuilder("reindex-filter-fault")
            .WithPlugin("Plugin.esp", mod => mod.Npcs.AddNew("Npc"))
            .Build();
        using (data)
        {
            var reflector = SharedSchemaReflector.Instance;
            var inner = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
            var faulting = new FaultingSetFilterRepositoryFactory(inner);
            var entries = new List<LogEntry>();
            using var loggerFactory = LoggerFactory.Create(b =>
            {
                b.SetMinimumLevel(LogLevel.Debug);
                b.AddProvider(new CollectingLoggerProvider(entries));
            });
            using var manager = new IndexProjector(holder, MutagenPluginAdapter.Instance, faulting, loggerFactory.CreateLogger<IndexProjector>());

            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            manager.SetFilter("SELECT form_key FROM npc_");
            faulting.FaultNextCall = true;

            var pluginKey = new PluginKey("Plugin.esp", data.Plugins.Single(p => p.Name == "Plugin.esp").Origin);
            var ex = await Record.ExceptionAsync(() => manager.ReindexPlugin(pluginKey));

            Assert.Null(ex);
            Assert.Contains(entries, e =>
                e.Level == LogLevel.Warning && e.Message.Contains("simulated re-materialization fault", StringComparison.Ordinal));
        }
    }

    // --- helpers ---

    private sealed class SpyRepositoryFactory(IRecordIndexFactory inner) : IRecordIndexFactory
    {
        private readonly IRecordIndexFactory _inner = inner;
        public int CreateCallCount { get; private set; }
        public GameRelease? LastGameRelease { get; private set; }

        public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null)
        {
            CreateCallCount++;
            LastGameRelease = gameRelease;
            return _inner.Create(gameRelease);
        }

        public IRecordIndex Rebuild(GameRelease gameRelease, string instanceRoot, long atLeastSequence) =>
            _inner.Rebuild(gameRelease, instanceRoot, atLeastSequence);
    }

    // A real DuckDbRecordIndex wrapped through DelegatingRecordIndex (TestSupport) with one member
    // intercepted — real DuckDB behaviour everywhere except the one call this test needs to fault.
    private sealed class FaultingSetFilterRepositoryFactory(IRecordIndexFactory inner) : IRecordIndexFactory
    {
        public bool FaultNextCall;

        public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null) =>
            new FaultingSetFilterRepository(inner.Create(gameRelease, instanceRoot), this);
        public IRecordIndex Rebuild(GameRelease gameRelease, string instanceRoot, long atLeastSequence) =>
            inner.Rebuild(gameRelease, instanceRoot, atLeastSequence);
    }

    private sealed class FaultingSetFilterRepository(IRecordIndex inner, FaultingSetFilterRepositoryFactory owner)
        : DelegatingRecordIndex(inner)
    {
        public override void SetFilter(string? sql)
        {
            if (owner.FaultNextCall)
            {
                owner.FaultNextCall = false;
                throw new FakeDbFault("simulated re-materialization fault");
            }
            base.SetFilter(sql);
        }
    }

    // DuckDBException is the type SetFilter's SQL execution really throws, but its constructors are
    // internal to that assembly, so this is the smallest concrete DbException provable from outside.
    // The catch is typed on the DbException base.
    private sealed class FakeDbFault(string message) : System.Data.Common.DbException(message);

    // UpdateWinners runs once, after IndexProgressively's per-plugin loop — faulting it fails
    // the load synchronously, on the calling thread, after publish, with no gate/thread coordination
    // needed to isolate IndexAndStore's own catch (DisposeCurrent) from a later call's cleanup.
    private sealed class FaultingUpdateWinnersRepositoryFactory(IRecordIndexFactory inner) : IRecordIndexFactory
    {
        public IRecordIndex Create(GameRelease gameRelease, string? instanceRoot = null) =>
            new FaultingUpdateWinnersRepository(inner.Create(gameRelease, instanceRoot));
        public IRecordIndex Rebuild(GameRelease gameRelease, string instanceRoot, long atLeastSequence) =>
            inner.Rebuild(gameRelease, instanceRoot, atLeastSequence);
    }

    private sealed class FaultingUpdateWinnersRepository(IRecordIndex inner) : DelegatingRecordIndex(inner)
    {
        public override void UpdateWinners(IReadOnlyList<RegisteredCopy> participating) =>
            throw new InvalidOperationException("simulated mid-load winner-sweep fault");
    }



    // --- Disposal actually releases resources ---

    [Fact]
    public void Reconcile_ForADifferentInstance_OldRepositoryBecomesUnusable()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeManager(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var oldRepo = manager.Reads;

        // ADR-0013: only a snapshot for another instance replaces what is held; the same instance
        // reconciles in place (Reconcile_SameInstance_KeepsTheRepositoryAndLoadOrder).
        var otherInstance = Directory.CreateDirectory(Path.Combine(_fixture.InstanceRoot, "other-instance")).FullName;
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, otherInstance);

        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data")));
    }


    [Fact]
    public void Dispose_RepositoryBecomesUnusable()
    {
        var holder = new LoadOrderHolder();
        var manager = MakeManager(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var oldRepo = manager.Reads;

        manager.Dispose();

        Assert.ThrowsAny<Exception>(() =>
            oldRepo!.GetRecordTypeCounts(new PluginKey(TestPluginFixture.PluginName, "Data")));
    }





    // --- Load disposes previous load order ---

    // --- helpers ---

    private IndexProjector MakeLoadedManager(LoadOrderHolder holder)
    {
        var m = MakeManager(holder);
        m.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        return m;
    }
}
