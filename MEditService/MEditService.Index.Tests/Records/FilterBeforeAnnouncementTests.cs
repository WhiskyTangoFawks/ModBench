using System.Collections.Concurrent;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

public sealed class FilterBeforeAnnouncementTests
{
    private const string Resident = "Resident.esp";
    private const string Arriving = "Arriving.esp";

    private sealed class FilteredNpcsAtEachAnnouncement(Predicate<INotification> announces) : INotificationPublisher
    {
        private readonly ConcurrentQueue<int> _listed = new();

        internal OpenedIndex? Index { get; set; }

        internal IReadOnlyList<int> Listed => [.. _listed];

        public void Publish(INotification notification)
        {
            if (Index is { } index && announces(notification))
                _listed.Enqueue(index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Total);
        }
    }

    [Fact]
    public void AnArrivingPlugin_IsAnnouncedAsIndexed_OnlyOnceTheRecordFilterHoldsItsMatches()
    {
        using var fixture = new PluginFixtureBuilder("filter-before-arrival")
            .WithPlugin(Resident, mod => mod.Npcs.AddNew("ResidentNpc"))
            .WithPlugin(Arriving, mod => mod.Npcs.AddNew("ArrivingNpc"))
            .BuildScattered();
        var arriving = fixture.Plugins.Single(p => p.Name == Arriving).KeyOf();
        var probe = new FilteredNpcsAtEachAnnouncement(n =>
            n is LoadOrderStatusNotification status && status.Status.IndexedPlugins.Contains(arriving, PluginAddress.Comparer));
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: probe);
        probe.Index = index;
        index.Reconcile(holder, fixture.GameDirectory, [.. fixture.Plugins.Where(p => p.Name == Resident)], GameRelease.Fallout4);
        index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'ArrivingNpc'", "filter.sql");

        index.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4);

        Assert.NotEmpty(probe.Listed);
        Assert.All(probe.Listed, listed => Assert.Equal(1, listed));
    }

    [Fact]
    public void ATrackedPluginEditedWhileOutOfTheLoadOrder_AnnouncesItsRowsOnReturn_OnlyOnceTheRecordFilterHoldsThem()
    {
        string npc = "";
        using var fixture = new PluginFixtureBuilder("filter-before-rows-changed")
            .WithPlugin(Resident, mod => mod.Npcs.AddNew("ResidentNpc"))
            .WithPlugin(Arriving, mod => npc = mod.Npcs.AddNew("TrackedNpc").FormKey.ToString(), origin: "TrackedMod")
            .BuildScattered();
        var tracked = fixture.Plugins.Single(p => p.Name == Arriving);
        TrackedMods.Track(tracked, fixture.GameDirectory);
        var probe = new FilteredNpcsAtEachAnnouncement(n => n is RowsChangedNotification rows && rows.Keys.Contains(npc));
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: probe);
        probe.Index = index;
        index.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4);
        var document = index.DocumentOf(npc, tracked.KeyOf());
        index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'EditedWhileAway'", "filter.sql");
        index.Reconcile(holder, fixture.GameDirectory, [.. fixture.Plugins.Where(p => p.Name == Resident)], GameRelease.Fallout4);
        tracked.HandEdit(document, "\"TrackedNpc\"", "\"EditedWhileAway\"");

        index.Reconcile(holder, fixture.GameDirectory, fixture.Plugins, GameRelease.Fallout4);

        Assert.NotEmpty(probe.Listed);
        Assert.All(probe.Listed, listed => Assert.Equal(1, listed));
    }
}
