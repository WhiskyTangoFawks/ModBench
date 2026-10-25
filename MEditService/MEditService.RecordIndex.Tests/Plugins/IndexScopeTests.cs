using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Plugins;

[Collection(TestPluginFixtureCollection.Name)]
public class IndexScopeTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    [Fact]
    public void AClosedIndex_HoldsNoLoadOrder()
    {
        using var index = Indexes.Reconciled(_fixture.DataFolder, _fixture.Plugins);
        index.Dispose();

        Assert.Equal(IndexRefusal.NoLoadOrder, index.Queries.GetPlugins().Refused().Refusal);
    }

    [Fact]
    public void AFilterClearedBeforeAnyLoadOrder_LeavesNoFilterOnceOneArrives()
    {
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        index.ClearFilter();
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);

        Assert.Null(index.Queries.GetFilter().Value());
    }

    private static readonly Dictionary<string, Action<OpenedIndex, TestPluginFixture, string>> ArrivalsOutsideTheFiltersScope = new()
    {
        ["another instance"] = (index, fixture, elsewhere) =>
            index.Reconcile(index.Holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4, elsewhere),
        ["another game release, then this one again"] = (index, fixture, _) =>
        {
            index.Reconcile(index.Holder, fixture.DataFolder, fixture.Plugins, GameRelease.SkyrimSE);
            index.Reconcile(index.Holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);
        },
        ["another data folder"] = (index, _, elsewhere) =>
            index.Reconcile(index.Holder, elsewhere, [], GameRelease.Fallout4),
    };

    [Theory]
    [InlineData("another instance")]
    [InlineData("another game release, then this one again")]
    [InlineData("another data folder")]
    public void ASnapshotOutsideTheFiltersScope_DropsTheFilter(string arrival)
    {
        using var elsewhere = new ScratchDirectory("medit-filter-elsewhere-");
        using var index = Indexes.Reconciled(_fixture.DataFolder, _fixture.Plugins);
        index.SetFilter("SELECT form_key FROM \"NPC_\"", "filter.sql");

        ArrivalsOutsideTheFiltersScope[arrival](index, _fixture, elsewhere);

        Assert.Null(index.Queries.GetFilter().Value());
    }

    [Theory]
    [InlineData("NotMatchingYet", "NowMatches", "NowMatches", 0, 1)]
    [InlineData("StillMatches", "StillMatches", "NoLongerMatches", 1, 0)]
    public void ABinaryChangeToARecord_ReappliesTheFilterToIt(
        string editorIdBefore, string editorIdTheFilterMatches, string editorIdAfter, int listedBefore, int listedAfter)
    {
        FormKey npcKey = default;
        using var data = new PluginFixtureBuilder("reindex-filter-reapplied")
            .WithPlugin("Plugin.esp", mod => npcKey = mod.Npcs.AddNew(editorIdBefore).FormKey)
            .Build();
        using var index = Indexes.Reconciled(data);
        index.SetFilter($"SELECT form_key FROM npc_ WHERE editor_id = '{editorIdTheFilterMatches}'", "filter.sql");
        Assert.Equal(listedBefore, NpcsListed(index).Total);

        RenameNpcOnDisk(data, "Plugin.esp", npcKey, editorIdAfter);
        index.NextSnapshot();

        Assert.Equal(listedAfter, NpcsListed(index).Total);
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
            Assert.Null(index.Queries.GetFilter().Value());
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
    public void ASnapshotOfAnotherInstance_ReleasesTheFirstInstancesIndexFile()
    {
        using var first = new ScratchDirectory("medit-first-instance-");
        using var second = new ScratchDirectory("medit-second-instance-");
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, first);

        index.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, second);

        Assert.Null(Record.Exception(() => ForeignIndexHolder.Hold(IndexFiles.In(first)).Dispose()));
    }

    private static PagedResult<RecordSummary> NpcsListed(OpenedIndex index) =>
        index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value();
}
