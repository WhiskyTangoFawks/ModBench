using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class InactivePluginProjectionTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly LoadOrderEntry _partner;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;
    private readonly string _npc;

    public InactivePluginProjectionTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("inactive-projection")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .WithPlugin("Partner.esp", mod => mod.Npcs.AddNew("PartnerNpc"), origin: "PartnerMod")
            .BuildScattered()
            .CompiledPlugin();
        _mod = _fixture.Plugins.Single(p => p.Name == "Fixture.esp");
        _partner = _fixture.Plugins.Single(p => p.Name == "Partner.esp");
        _npc = npc.ToString();
        _index = Indexes.Open(_holder, notifications: _notifications);
        Reconcile(active: true);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void Reconcile(bool active) =>
        _index.Reconcile(_holder, _fixture.DataFolder, [_mod with { Enabled = active }, _partner], GameRelease.Fallout4);

    [Fact]
    public void APluginRow_IsInTheLoadOrderExactlyWhenItIsActive()
    {
        PluginResponse Row() => Assert.IsType<PluginResponse>(_index.PluginResponseOf(_mod.Key));
        Assert.True(Row().InLoadOrder);
        Assert.NotNull(Row().LoadOrderIndex);

        Reconcile(active: false);

        Assert.False(Row().InLoadOrder);
        Assert.Null(Row().LoadOrderIndex);
    }

    [Fact]
    public void AHandEditWhileNotActive_IsTheRecordTheReadsSeeOnceActive()
    {
        var document = _index.DocumentOf(_npc, _mod.Key);
        Reconcile(active: false);

        _mod.HandEdit(document, "\"FixtureNpc\"", "\"RenamedByHand\"");
        _index.NextSnapshot();
        Reconcile(active: true);

        Assert.Equal("RenamedByHand", _index.CopyIn(_npc, _mod.Key)?.EditorId);
    }

    [Fact]
    public void AHandEditWhileNotActive_IsProjectedOnce()
    {
        var document = _index.DocumentOf(_npc, _mod.Key);
        Reconcile(active: false);
        _mod.HandEdit(document, "\"FixtureNpc\"", "\"RenamedByHand\"");
        _index.NextSnapshot();

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(_index));

        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc));
    }

    [Fact]
    public void ACopyGivenAsText_ReadsWhenOnlyAPluginThatIsNotActiveHoldsItsRecord()
    {
        var text = _index.BodyOf(_npc, _mod.Key);
        Reconcile(active: false);

        Assert.Null(_index.CopyIn(_npc, _mod.Key));
        Assert.NotNull(_index.Queries.GetCompare(_npc, new CopyText(_mod.Key, text)).Value());
    }

    [Fact]
    public void ASearchOfOnePlugin_FindsARecordOfAPluginThatIsNotActive()
    {
        Reconcile(active: false);

        var found = _index.Queries.GetRecords(types: null, _mod.Key, search: "FixtureNpc", limit: 100, offset: 0).Value();

        Assert.Equal(_npc, Assert.Single(found.Items).FormKey);
    }

    [Fact]
    public void ASearchAcrossPlugins_LeavesOutAPluginThatIsNotActive()
    {
        Reconcile(active: false);

        var found = _index.Queries.GetRecords(types: null, plugin: null, search: "FixtureNpc", limit: 100, offset: 0).Value();

        Assert.Empty(found.Items);
    }

    [Fact]
    public void ACompiledPluginThatIsNotActive_IsStillReadAsCompiledPlugin()
    {
        Reconcile(active: false);

        Assert.True(_index.ReadFromItsPluginSource(_mod.Key));
    }

    [Fact]
    public void ASnapshotThatMovesNothing_ProjectsNothingForACompiledPluginThatIsNotActive()
    {
        Reconcile(active: false);

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(_index));

        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc));
        Assert.DoesNotContain(announced, Announcements.PluginChanged(_mod));
    }
}
