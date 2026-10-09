using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

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
            .Tracked();
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
        _index.Reconcile(_holder, _fixture.GameDirectory, [_mod with { Enabled = active }, _partner], GameRelease.Fallout4);

    [Fact]
    public void AHandEditWhileNotActive_IsTheRecordTheReadsSeeOnceActive()
    {
        var document = _index.DocumentOf(_npc, _mod.KeyOf());
        Reconcile(active: false);

        _mod.HandEdit(document, "\"FixtureNpc\"", "\"RenamedByHand\"");
        _index.NextSnapshot();
        Reconcile(active: true);

        Assert.Equal("RenamedByHand", _index.CopyIn(_npc, _mod.KeyOf())?.EditorId);
    }

    [Fact]
    public void AHandEditWhileNotActive_IsProjectedOnce()
    {
        var document = _index.DocumentOf(_npc, _mod.KeyOf());
        Reconcile(active: false);
        _mod.HandEdit(document, "\"FixtureNpc\"", "\"RenamedByHand\"");
        _index.NextSnapshot();

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(_index));

        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc));
    }

    [Fact]
    public void ACopyGivenAsText_ReadsWhenOnlyAPluginThatIsNotActiveHoldsItsRecord()
    {
        var text = _index.BodyOf(_npc, _mod.KeyOf());
        Reconcile(active: false);

        Assert.Null(_index.CopyIn(_npc, _mod.KeyOf()));
        Assert.NotNull(_index.Records.GetCompare(_npc, new CopyText(_mod.KeyOf(), text)));
    }

    [Fact]
    public void ASearchOfOnePlugin_FindsARecordOfAPluginThatIsNotActive()
    {
        Reconcile(active: false);

        var found = _index.Records.GetRecords(types: null, _mod.KeyOf(), search: "FixtureNpc", limit: 100, offset: 0);

        Assert.Equal(_npc, Assert.Single(found.Items).FormKey);
    }

    [Fact]
    public void ASearchAcrossPlugins_LeavesOutAPluginThatIsNotActive()
    {
        Reconcile(active: false);

        var found = _index.Records.GetRecords(types: null, plugin: null, search: "FixtureNpc", limit: 100, offset: 0);

        Assert.Empty(found.Items);
    }

    [Fact]
    public void ATrackedPluginThatIsNotActive_IsStillReadAsTracked()
    {
        Reconcile(active: false);

        var row = _index.PluginRowOf(_mod.KeyOf()) ?? throw new InvalidOperationException("Expected the plugin's row.");
        Assert.True(row.IsTracked);
        Assert.Null(row.PluginSourceUnreadableReason);
    }

    [Fact]
    public void ASnapshotThatMovesNothing_ProjectsNothingForATrackedPluginThatIsNotActive()
    {
        Reconcile(active: false);

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(_index));

        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc));
        Assert.DoesNotContain(announced, Announcements.PluginChanged(_mod));
    }
}
