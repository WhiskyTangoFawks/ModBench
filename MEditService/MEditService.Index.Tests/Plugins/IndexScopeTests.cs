using MEditService.Index.Queries;
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

        Assert.Equal(TestPluginFixture.PluginName, Assert.Single(index.Records.GetPlugins()).Plugin.Name);
    }

    [Fact]
    public void Dispose_LeavesNoLoadOrder()
    {
        var holder = new LoadOrderHolder();
        using var index = OpenIndex(holder);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        index.Dispose();

        Assert.Throws<NoLoadOrderException>(() => index.Records.GetPlugins());
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
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.Null(index.Records.GetFilter());
    }

    [Fact]
    public void SetFilter_KeepsItsSqlAsTheActiveFilter()
    {
        var holder = new LoadOrderHolder();
        using var index = ReconciledIndex(holder);
        index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        Assert.Equal("SELECT form_key FROM \"NPC_\"", index.Records.GetFilter()?.Sql);
    }

    [Fact]
    public void ClearFilter_AfterSetFilter_LeavesNoActiveFilter()
    {
        var holder = new LoadOrderHolder();
        using var index = ReconciledIndex(holder);
        index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        index.ClearFilter();
        Assert.Null(index.Records.GetFilter());
    }

    [Fact]
    public void Reconcile_AnotherInstance_DropsTheFilter()
    {
        var holder = new LoadOrderHolder();
        using var index = ReconciledIndex(holder);
        index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        using var otherInstance = new ScratchDirectory("medit-filter-other-instance-");

        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, otherInstance);

        Assert.Null(index.Records.GetFilter());
    }

    [Fact]
    public void Reconcile_AnotherGameRelease_DropsTheFilter()
    {
        var holder = new LoadOrderHolder();
        using var index = ReconciledIndex(holder);
        index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");

        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.SkyrimSE);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.Null(index.Records.GetFilter());
    }

    [Fact]
    public void Reconcile_AnotherDataFolder_DropsTheFilter()
    {
        var holder = new LoadOrderHolder();
        using var index = ReconciledIndex(holder);
        index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");
        using var other = new PluginFixtureBuilder("filter-other-data-folder").WithPlugin("Other.esp").Build();

        index.Reconcile(holder, other.DataFolder, other.Plugins, GameRelease.Fallout4);

        Assert.Null(index.Records.GetFilter());
    }

    [Fact]
    public void AfterABinaryChangeMakesARecordNewlyMatchTheFilter_TheFilteredListingIncludesIt()
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

            index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'NowMatches'", "filter.sql");
            Assert.Equal(0, NpcsListed(index).Total);

            RenameNpcOnDisk(data, "Plugin.esp", npcKey, "NowMatches");

            index.NextSnapshot();

            var result = NpcsListed(index);
            Assert.Equal(1, result.Total);
            Assert.Equal(npcKey.ToString(), result.Items[0].FormKey);
        }
    }

    [Fact]
    public void AfterABinaryChangeMakesARecordStopMatchingTheFilter_TheFilteredListingExcludesIt()
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

            index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'StillMatches'", "filter.sql");
            Assert.Equal(1, NpcsListed(index).Total);

            RenameNpcOnDisk(data, "Plugin.esp", npcKey, "NoLongerMatches");

            index.NextSnapshot();

            var result = NpcsListed(index);
            Assert.Equal(0, result.Total);
        }
    }

    [Fact]
    public void AFilterThatFaultsOnReapply_IsCleared_NamesItsSourceAndReason_AndShowsEveryRecord()
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
                index.ListedIn(new PluginAddress("Plugin.esp", PluginOrigin.DataDirectory)),
                row => row.EditorId == "NotANumber");
            Assert.Null(index.Records.GetFilter());
            var cleared = Assert.Single(notifications.Notifications.OfType<RecordFilterClearedNotification>());
            Assert.Equal("filter.sql", cleared.Source);
            Assert.Contains("NotANumber", cleared.Reason, StringComparison.Ordinal);
            var listing = NpcsListed(index);
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

    [ForeignIndexHolderFact]
    public void Reconcile_ForADifferentInstance_ReleasesTheFirstInstancesIndex()
    {
        using var first = new ScratchDirectory("medit-first-instance-");
        using var second = new ScratchDirectory("medit-second-instance-");
        var holder = new LoadOrderHolder();
        using var index = OpenIndex(holder);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, first);

        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, second);

        Assert.Null(Record.Exception(() => ForeignIndexHolder.Hold(IndexFiles.In(first)).Dispose()));
    }

    private static PagedResult<RecordSummary> NpcsListed(OpenedIndex index) =>
        index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0);

    private OpenedIndex ReconciledIndex(LoadOrderHolder holder)
    {
        var m = OpenIndex(holder);
        m.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        return m;
    }
}
