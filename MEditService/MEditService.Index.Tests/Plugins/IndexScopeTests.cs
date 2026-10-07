using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

[Collection(TestPluginFixtureCollection.Name)]
public class IndexScopeTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private static OpenedIndex OpenIndex(LoadOrderHolder holder) => Indexes.Open(holder);

    [Fact]
    public void Reconcile_ForAnUnsupportedGameRelease_FailsNamingTheRelease()
    {
        var holder = new LoadOrderHolder();
        using var index = OpenIndex(holder);

        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.SkyrimSE);

        Assert.Equal(LoadOrderState.Failed, index.Status.State);
        Assert.Contains("SkyrimSE", index.Status.Message);
    }

    [Fact]
    public void Reconcile_HoldsTheSnapshotsPlugins()
    {
        var holder = new LoadOrderHolder();
        using var index = OpenIndex(holder);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        var reads = index.RequireReads();
        Assert.Equal(TestPluginFixture.PluginName, Assert.Single(reads.OpenedPlugins).Key.Name);
    }

    [Fact]
    public void Reconcile_IndexesThePluginsRecords()
    {
        var holder = new LoadOrderHolder();
        using var index = OpenIndex(holder);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        var count = index.RequireReads().CountOf(new PluginAddress(TestPluginFixture.PluginName, "Data"), "npc_");

        Assert.Equal(TestPluginFixture.RecordCount, count);
    }

    [Fact]
    public void Reconcile_ALonePlugin_MarksEveryRecordAWinner()
    {
        var holder = new LoadOrderHolder();
        using var index = OpenIndex(holder);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        var result = index.RequireReads().Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 100, Offset: 0));

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.All(result.Items, r => Assert.True(r.IsWinner));
    }

    [Fact]
    public void Dispose_LeavesNoLoadOrder_AndClosesTheReadsHandedOutBefore()
    {
        var holder = new LoadOrderHolder();
        using var index = OpenIndex(holder);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var oldReads = index.RequireReads();
        index.Dispose();

        Assert.Throws<NoLoadOrderException>(() => index.RequireReads());
        Assert.Throws<ObjectDisposedException>(() =>
            oldReads.GetRecordTypeCounts(new PluginAddress(TestPluginFixture.PluginName, "Data")));
    }

    [Fact]
    public void Reconcile_SameInstance_KeepsTheStore()
    {
        var holder = new LoadOrderHolder();
        using var index = OpenIndex(holder);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var firstReads = index.RequireReads();

        index.Reconcile(holder, _fixture.DataFolder, [.. _fixture.Plugins.Select(p => p with { Enabled = false })], GameRelease.Fallout4);

        Assert.Same(firstReads, index.RequireReads());
    }

    [Fact]
    public void SetFilter_NoLoadOrder_ThrowsNoLoadOrderException()
    {
        var holder = new LoadOrderHolder();
        using var index = OpenIndex(holder);
        var ex = Assert.Throws<NoLoadOrderException>(() => index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql"));
        Assert.Contains("No load order", ex.Message);
    }

    [Fact]
    public void ClearFilter_NoLoadOrder_LeavesNoFilter()
    {
        var holder = new LoadOrderHolder();
        using var index = OpenIndex(holder);

        index.ClearFilter();

        Assert.Null(index.ActiveFilter);
    }

    [Fact]
    public void SetFilter_KeepsItsSqlAsTheActiveFilter()
    {
        var holder = new LoadOrderHolder();
        using var index = ReconciledIndex(holder);
        index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        Assert.Equal("SELECT form_key FROM \"NPC_\"", index.ActiveFilter?.Sql);
    }

    [Fact]
    public void ClearFilter_AfterSetFilter_LeavesNoActiveFilter()
    {
        var holder = new LoadOrderHolder();
        using var index = ReconciledIndex(holder);
        index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        index.ClearFilter();
        Assert.Null(index.ActiveFilter);
    }

    [Fact]
    public void Reconcile_AnotherInstance_DropsTheFilter()
    {
        var holder = new LoadOrderHolder();
        using var index = ReconciledIndex(holder);
        index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        using var otherInstance = new ScratchDirectory("medit-filter-other-instance-");

        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, otherInstance);

        Assert.Null(index.ActiveFilter);
    }

    [Fact]
    public void Reconcile_AnotherGameRelease_DropsTheFilter()
    {
        var holder = new LoadOrderHolder();
        using var index = ReconciledIndex(holder);
        index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");

        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.SkyrimSE);

        Assert.Null(index.ActiveFilter);
    }

    [Fact]
    public void Reconcile_AnotherDataFolder_DropsTheFilter()
    {
        var holder = new LoadOrderHolder();
        using var index = ReconciledIndex(holder);
        index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        using var other = new PluginFixtureBuilder("filter-other-data-folder").WithPlugin("Other.esp").Build();

        index.Reconcile(holder, other.DataFolder, other.Plugins, GameRelease.Fallout4);

        Assert.Null(index.ActiveFilter);
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
            using var index = OpenIndex(holder);
            index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var reads = index.RequireReads();

            index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'NowMatches'", "filter.sql");
            Assert.Equal(0, reads.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            RenameNpcOnDisk(data, "Plugin.esp", npcKey, "NowMatches");

            index.NextSnapshot();

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
            using var index = OpenIndex(holder);
            index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            var reads = index.RequireReads();

            index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'StillMatches'", "filter.sql");
            Assert.Equal(1, reads.Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

            RenameNpcOnDisk(data, "Plugin.esp", npcKey, "NoLongerMatches");

            index.NextSnapshot();

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
            .WithPlugin("Plugin.esp", mod =>
            {
                npcKey = mod.Npcs.AddNew("7").FormKey;
                mod.Npcs.AddNew("8");
            })
            .Build();
        using (data)
        {
            var notifications = new InMemoryNotificationPublisher();
            using var index = Indexes.Open(holder, notifications: notifications);

            index.Reconcile(holder, data.DataFolder, data.Plugins, GameRelease.Fallout4);
            index.SetFilter("SELECT form_key FROM npc_ WHERE CAST(editor_id AS INTEGER) = 7", "filter.sql");

            RenameNpcOnDisk(data, "Plugin.esp", npcKey, "NotANumber");

            index.NextSnapshot();

            Assert.Contains(
                index.RequireReads().DocumentsOf(new PluginAddress("Plugin.esp", "Data")),
                d => d.EditorId == "NotANumber");
            Assert.Null(index.ActiveFilter);
            var cleared = Assert.Single(notifications.Notifications.OfType<RecordFilterClearedNotification>());
            Assert.Equal("filter.sql", cleared.Source);
            Assert.Contains("NotANumber", cleared.Reason, StringComparison.Ordinal);
            var listing = index.RequireReads().Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["npc_"], Limit: 10, Offset: 0));
            Assert.Equal(2, listing.Total);
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
    public void Reconcile_ForADifferentInstance_ClosesTheReadsHandedOutBefore()
    {
        var holder = new LoadOrderHolder();
        using var index = OpenIndex(holder);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        var oldReads = index.RequireReads();

        var otherInstance = Directory.CreateDirectory(Path.Combine(_fixture.InstanceRoot, "other-instance")).FullName;
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, otherInstance);

        Assert.Throws<ObjectDisposedException>(() =>
            oldReads.GetRecordTypeCounts(new PluginAddress(TestPluginFixture.PluginName, "Data")));
    }

    [Fact]
    public void Dispose_ClosesTheReadsHandedOutBefore()
    {
        var holder = new LoadOrderHolder();
        var index = OpenIndex(holder);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        var oldReads = index.RequireReads();

        index.Dispose();

        Assert.Throws<ObjectDisposedException>(() =>
            oldReads.GetRecordTypeCounts(new PluginAddress(TestPluginFixture.PluginName, "Data")));
    }

    private OpenedIndex ReconciledIndex(LoadOrderHolder holder)
    {
        var m = OpenIndex(holder);
        m.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        return m;
    }
}
