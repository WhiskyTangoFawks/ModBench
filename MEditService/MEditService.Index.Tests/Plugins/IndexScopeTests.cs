using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

[Collection(TestPluginFixtureCollection.Name)]
public class IndexScopeTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private static OpenedIndex MakeIndexer(LoadOrderHolder holder) => Indexes.Open(holder);

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

        var result = manager.RequireReads().Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 100, Offset: 0));

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

        manager.Reconcile(holder, _fixture.DataFolder, [.. _fixture.Plugins.Select(p => p with { Enabled = false })], GameRelease.Fallout4);

        Assert.Same(firstRepo, manager.RequireReads());
    }

    [Fact]
    public void SetFilter_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeIndexer(holder);
        var ex = Assert.Throws<NoLoadOrderException>(() => manager.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql"));
        Assert.Contains("No load order", ex.Message);
    }

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
        Assert.Equal("SELECT form_key FROM \"NPC_\"", manager.ActiveFilter?.Sql);
    }

    [Fact]
    public void ClearFilter_AfterSetFilter_ClearsSqlOnLoadOrder()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeLoadedManager(holder);
        manager.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        manager.ClearFilter();
        Assert.Null(manager.ActiveFilter);
    }

    [Fact]
    public void Reconcile_AnotherInstance_DropsTheFilter()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeLoadedManager(holder);
        manager.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        using var otherInstance = new ScratchDirectory("medit-filter-other-instance-");

        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, otherInstance);

        Assert.Null(manager.ActiveFilter);
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

    [Fact]
    public void Validate_AfterBinaryChangeMakesARecordNewlyMatchTheFilter_FilteredListingIncludesIt()
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
            Assert.Equal(0, reads.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            RenameNpcOnDisk(data, "Plugin.esp", npcKey, "NowMatches");

            manager.NextSnapshot();

            var result = reads.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(1, result.Total);
            Assert.Equal(npcKey.ToString(), result.Items[0].FormKey);
        }
    }

    [Fact]
    public void Validate_AfterBinaryChangeMakesARecordStopMatchingTheFilter_FilteredListingExcludesIt()
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
            Assert.Equal(1, reads.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            RenameNpcOnDisk(data, "Plugin.esp", npcKey, "NoLongerMatches");

            manager.NextSnapshot();

            var result = reads.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(0, result.Total);
        }
    }

    [Fact]
    public void Validate_WhenReapplyingTheFilterFaults_ClearsTheFilter_NamesItsSourceAndReason_AndShowsEveryRecord()
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
            var notifications = new InMemoryNotificationPublisher();
            using var manager = Indexes.Open(holder, loggerFactory: loggerFactory, notifications: notifications);

            manager.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            manager.SetFilter("SELECT form_key FROM npc_ WHERE CAST(editor_id AS INTEGER) = 7", "filter.sql");

            RenameNpcOnDisk(data, "Plugin.esp", npcKey, "NotANumber");

            manager.NextSnapshot();

            Assert.Contains(entries, e =>
                e.Level == LogLevel.Warning
                && e.Message.Contains("re-materialize the active filter", StringComparison.Ordinal)
                && e.Message.Contains("NotANumber", StringComparison.Ordinal));
            Assert.Contains(
                manager.RequireReads().DocumentsOf(new PluginAddress("Plugin.esp", "Data")),
                d => d.EditorId == "NotANumber");
            Assert.Null(manager.ActiveFilter);
            var cleared = Assert.Single(notifications.Notifications.OfType<RecordFilterClearedNotification>());
            Assert.Equal("filter.sql", cleared.Source);
            Assert.Contains("NotANumber", cleared.Reason, StringComparison.Ordinal);
            var listing = manager.RequireReads().Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(1, listing.Total);
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

    [Fact]
    public void Reconcile_ForADifferentInstance_OldRepositoryBecomesUnusable()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeIndexer(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var oldRepo = manager.RequireReads();

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

    private OpenedIndex MakeLoadedManager(LoadOrderHolder holder)
    {
        var m = MakeIndexer(holder);
        m.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        return m;
    }
}
