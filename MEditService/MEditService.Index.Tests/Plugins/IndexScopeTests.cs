using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

/// <summary>The Index's scope — the store it opens, the plugins it holds open in it, and the filter
/// materialized over it — across a reconcile, a replacement, a close and a dispose.</summary>
[Collection(TestPluginFixtureCollection.Name)]
public class IndexScopeTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private static Indexer MakeIndexer(LoadOrderHolder holder) => Indexes.Open(holder);

    // An explicit request for a release this build has no Mutagen assembly for must refuse with a
    // typed, actionable message rather than a FileNotFoundException's from inside Initialize.
    [Fact]
    public void Load_ForUnsupportedGameRelease_FailsNamingTheRelease()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeIndexer(holder);

        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.SkyrimSE);

        Assert.Equal(LoadOrderState.Failed, manager.Status.State);
        Assert.Contains("SkyrimSE", manager.Status.Message);
    }

    [Fact]
    public void Load_PopulatesLoadOrderAndRepository()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeIndexer(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        var reads = manager.RequireReads();
        Assert.Equal(TestPluginFixture.PluginName, Assert.Single(reads.OpenedPlugins).Key.Name);
    }

    [Fact]
    public void Load_IndexesRecordsIntoRepository()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeIndexer(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        var count = manager.RequireReads().CountOf(new PluginAddress(TestPluginFixture.PluginName, "Data"), "npc_");

        Assert.Equal(TestPluginFixture.RecordCount, count);
    }

    [Fact]
    public void Load_SetsIsWinnerOnSinglePlugin()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeIndexer(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        var result = manager.RequireReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 100, Offset: 0));

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.True(r.IsWinner));
    }

    [Fact]
    public void Dispose_ClearsReferencesAndDisposesRepository()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeIndexer(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var oldRepo = manager.RequireReads();
        manager.Dispose();

        Assert.Throws<NoLoadOrderException>(() => manager.RequireReads());
        Assert.ThrowsAny<Exception>(() =>
            oldRepo.GetRecordTypeCounts(new PluginAddress(TestPluginFixture.PluginName, "Data")));
    }

    [Fact]
    public void Reconcile_SameInstance_KeepsTheStore()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeIndexer(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var firstRepo = manager.RequireReads();

        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        // ADR-0013: a snapshot for the same instance reconciles in place — nothing is replaced.
        Assert.Same(firstRepo, manager.RequireReads());
    }

    // --- SetFilter / ClearFilter ---

    [Fact]
    public void SetFilter_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeIndexer(holder);
        var ex = Assert.Throws<NoLoadOrderException>(() => manager.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql"));
        Assert.Contains("No load order", ex.Message);
    }

    // plugins.md, Order and view state, story 5: the filter clears on purpose, whatever is held.
    [Fact]
    public void ClearFilter_NoLoadOrder_LeavesNoFilter()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeIndexer(holder);

        manager.ClearFilter();

        Assert.Null(manager.ActiveFilter);
    }

    [Fact]
    public void SetFilter_ValidSql_SetsSqlOnLoadOrder()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeLoadedManager(holder);
        manager.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        Assert.Equal("SELECT form_key FROM \"NPC_\"", manager.FilterSql);
    }

    [Fact]
    public void ClearFilter_AfterSetFilter_ClearsSqlOnLoadOrder()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeLoadedManager(holder);
        manager.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        manager.ClearFilter();
        Assert.Null(manager.FilterSql);
    }

    [Fact]
    public void Reconcile_AnotherInstance_DropsTheFilter()
    {
        var holder = new LoadOrderHolder();
        var manager = MakeLoadedManager(holder);
        manager.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        var otherInstance = Directory.CreateTempSubdirectory("medit-filter-other-instance-");
        try
        {
            manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, otherInstance.FullName);

            Assert.Null(manager.ActiveFilter);
        }
        finally
        {
            manager.Dispose();
            otherInstance.Delete(recursive: true);
        }
    }

    [Fact]
    public void Reconcile_AnotherGameRelease_DropsTheFilter()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeLoadedManager(holder);
        manager.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");

        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.SkyrimSE);

        Assert.Null(manager.ActiveFilter);
    }

    [Fact]
    public void Reconcile_AnotherDataFolder_DropsTheFilter()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeLoadedManager(holder);
        manager.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        using var other = new PluginFixtureBuilder("filter-other-data-folder").WithPlugin("Other.esp").Build();

        manager.Reconcile(holder, other.DataFolder, other.Plugins, GameRelease.Fallout4);

        Assert.Null(manager.ActiveFilter);
    }

    // --- Filter re-materialization ---
    //
    // _filter is a one-shot snapshot of whatever matched the filter SQL when it ran, so every mutation
    // path that can change which records match has to re-run it.

    [Fact]
    public async Task RefreshBinary_AfterBinaryChangeMakesARecordNewlyMatchTheFilter_FilteredListingIncludesIt()
    {
        var holder = new LoadOrderHolder();
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("reindex-filter-newly-matches")
            .WithPlugin("Plugin.esp", mod => npcKey = mod.Npcs.AddNew("NotMatchingYet").FormKey)
            .Build();
        using (data)
        {
            using var manager = MakeIndexer(holder);
            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var reads = manager.RequireReads();

            manager.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'NowMatches'", "filter.sql");
            Assert.Equal(0, reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            RenameNpcOnDisk(data, "Plugin.esp", npcKey, "NowMatches");

            var plugin = data.Plugins.Single(p => p.Name == "Plugin.esp");
            await manager.RefreshBinary(plugin.KeyOf(), plugin.Path);

            var result = reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(1, result.Total);
            Assert.Equal(npcKey.ToString(), result.Items[0].FormKey);
        }
    }

    [Fact]
    public async Task RefreshBinary_AfterBinaryChangeMakesARecordStopMatchingTheFilter_FilteredListingExcludesIt()
    {
        var holder = new LoadOrderHolder();
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("reindex-filter-stops-matching")
            .WithPlugin("Plugin.esp", mod => npcKey = mod.Npcs.AddNew("StillMatches").FormKey)
            .Build();
        using (data)
        {
            using var manager = MakeIndexer(holder);
            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var reads = manager.RequireReads();

            manager.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'StillMatches'", "filter.sql");
            Assert.Equal(1, reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            RenameNpcOnDisk(data, "Plugin.esp", npcKey, "NoLongerMatches");

            var plugin = data.Plugins.Single(p => p.Name == "Plugin.esp");
            await manager.RefreshBinary(plugin.KeyOf(), plugin.Path);

            var result = reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(0, result.Total);
        }
    }

    // A filter valid over the rows it was set on and not over the rows a re-index lands: the one
    // way a re-materialization can fail after the write it follows is already durable.
    [Fact]
    public async Task RefreshBinary_WhenReapplyingTheFilterFaults_DoesNotThrow_AndLogsAWarningNamingTheException()
    {
        var holder = new LoadOrderHolder();
        FormKey npcKey = default;
        var data = new PluginFixtureBuilder("reindex-filter-fault")
            .WithPlugin("Plugin.esp", mod => npcKey = mod.Npcs.AddNew("7").FormKey)
            .Build();
        using (data)
        {
            var entries = new List<LogEntry>();
            using var loggerFactory = LoggerFactory.Create(b =>
            {
                b.SetMinimumLevel(LogLevel.Debug);
                b.AddProvider(new CollectingLoggerProvider(entries));
            });
            using var manager = Indexes.Open(holder, loggerFactory: loggerFactory);

            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            manager.SetFilter("SELECT form_key FROM npc_ WHERE CAST(editor_id AS INTEGER) = 7", "filter.sql");

            RenameNpcOnDisk(data, "Plugin.esp", npcKey, "NotANumber");

            var plugin = data.Plugins.Single(p => p.Name == "Plugin.esp");
            var ex = await Record.ExceptionAsync(() => manager.RefreshBinary(plugin.KeyOf(), plugin.Path));

            Assert.Null(ex);
            Assert.Contains(entries, e =>
                e.Level == LogLevel.Warning
                && e.Message.Contains("re-materialize the active filter", StringComparison.Ordinal)
                && e.Message.Contains("NotANumber", StringComparison.Ordinal));
        }
    }

    private static void RenameNpcOnDisk(PluginFixtureData data, string pluginName, FormKey npcKey, string editorId)
    {
        var pluginPath = Path.Combine(data.DataFolder, pluginName);
        var onDisk = Fallout4Mod.CreateFromBinary(
            new ModPath(ModKey.FromFileName(pluginName), pluginPath), Fallout4Release.Fallout4);
        onDisk.Npcs.First(n => n.FormKey == npcKey).EditorID = editorId;
        onDisk.WriteToBinary(pluginPath);
    }

    // --- Disposal actually releases resources ---

    [Fact]
    public void Reconcile_ForADifferentInstance_OldRepositoryBecomesUnusable()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeIndexer(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var oldRepo = manager.RequireReads();

        // ADR-0013: only a snapshot for another instance replaces what is held; the same instance
        // reconciles in place (Reconcile_SameInstance_KeepsTheStore).
        var otherInstance = Directory.CreateDirectory(Path.Combine(_fixture.InstanceRoot, "other-instance")).FullName;
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, otherInstance);

        Assert.ThrowsAny<Exception>(() =>
            oldRepo.GetRecordTypeCounts(new PluginAddress(TestPluginFixture.PluginName, "Data")));
    }

    [Fact]
    public void Dispose_RepositoryBecomesUnusable()
    {
        var holder = new LoadOrderHolder();
        var manager = MakeIndexer(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var oldRepo = manager.RequireReads();

        manager.Dispose();

        Assert.ThrowsAny<Exception>(() =>
            oldRepo.GetRecordTypeCounts(new PluginAddress(TestPluginFixture.PluginName, "Data")));
    }

    private Indexer MakeLoadedManager(LoadOrderHolder holder)
    {
        var m = MakeIndexer(holder);
        m.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        return m;
    }
}
