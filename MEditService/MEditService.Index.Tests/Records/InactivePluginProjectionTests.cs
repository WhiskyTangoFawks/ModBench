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
    private readonly Indexer _index;
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

    private IRecordReads Reads => _index.RequireReads();

    private void Reconcile(bool active) =>
        _index.Reconcile(_holder, _fixture.GameDirectory, [_mod with { Enabled = active }, _partner], GameRelease.Fallout4);

    [Fact]
    public void AHandEditWhileNotActive_IsTheRecordTheReadsSeeOnceActive()
    {
        var document = Reads.DocumentOf(_npc, _mod.KeyOf());
        Reconcile(active: false);

        _mod.HandEdit(document, "\"FixtureNpc\"", "\"RenamedByHand\"");
        _index.NextSnapshot();
        Reconcile(active: true);

        Assert.Equal("RenamedByHand", Reads.GetDocument(_npc, _mod.KeyOf())?.EditorId);
    }

    [Fact]
    public void AHandEditWhileNotActive_IsProjectedOnce()
    {
        var document = Reads.DocumentOf(_npc, _mod.KeyOf());
        Reconcile(active: false);
        _mod.HandEdit(document, "\"FixtureNpc\"", "\"RenamedByHand\"");
        _index.NextSnapshot();

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(Reads));

        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc));
    }

    [Fact]
    public void ATrackedPluginThatIsNotActive_IsStillReadAsTracked()
    {
        Reconcile(active: false);

        Assert.Contains(_mod.KeyOf(), Reads.GetTrackedPlugins());
    }

    [Fact]
    public void ASnapshotThatMovesNothing_ProjectsNothingForATrackedPluginThatIsNotActive()
    {
        Reconcile(active: false);

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(Reads));

        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc));
        Assert.DoesNotContain(announced, Announcements.PluginChanged(_mod));
    }
}
