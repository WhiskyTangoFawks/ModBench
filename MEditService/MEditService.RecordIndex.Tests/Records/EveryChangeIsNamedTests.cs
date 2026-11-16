using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class EveryChangeIsNamedTests
{
    [Fact]
    public void ARecordWrittenInOnePlugin_IsNamedInEveryOtherPluginThatHoldsIt()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("named-in-every-holder")
            .WithPlugin("Base.esm", mod => npc = mod.Npcs.AddNew("SharedNpc").FormKey, origin: "BaseMod")
            .WithPlugin("Over.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.Set(built.Single(m => m.ModKey.FileName == "Base.esm").Npcs.First(n => n.FormKey == npc).DeepCopy());
            }, origin: "OverMod")
            .BuildScattered()
            .CompiledPlugin();
        var (baseEntry, overEntry) = (fixture.Plugins[0], fixture.Plugins[1]);
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(fixture, notifications: notifications);
        var formKey = npc.ToString();
        var before = notifications.Notifications.Count;
        overEntry.RenameByHand(index.DocumentOf(formKey, overEntry.Key), "EditedNpc");

        index.NextCheck();

        var named = notifications.Since(before).OfType<RowsChangedNotification>().ToList();
        Assert.Contains(named, n => n.Plugin.Equals(baseEntry.Key) && n.Keys.Contains(formKey));
        Assert.Contains(named, n => n.Plugin.Equals(overEntry.Key) && n.Keys.Contains(formKey));
        Assert.DoesNotContain(notifications.Since(before), n => n is RecordIndexChangedNotification);
    }

    [Fact]
    public void ActivatingAndDeactivatingAPlugin_AnnounceTheRecordsInOtherPluginsThatReferToItsRecords()
    {
        FormKey target = default, referrer = default;
        using var fixture = new PluginFixtureBuilder("activation-names-referrers")
            .WithPlugin("Base.esp", mod => target = mod.Npcs.AddNew("Target").FormKey, origin: "BaseMod")
            .WithPlugin("Refers.esp", mod =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esp") });
                var referring = mod.Npcs.AddNew("Referrer");
                referring.Race.SetTo(target.ToLinkGetter<IRaceGetter>());
                referrer = referring.FormKey;
            }, origin: "RefersMod")
            .BuildScattered()
            .CompiledPlugin();
        var (baseEntry, refersEntry) = (fixture.Plugins[0], fixture.Plugins[1]);
        var notifications = new InMemoryNotificationPublisher();
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder, notifications: notifications);
        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);

        var before = notifications.Notifications.Count;
        index.Reconcile(holder, fixture.DataFolder, [baseEntry with { Enabled = false }, refersEntry], GameRelease.Fallout4);
        var deactivated = notifications.Since(before).ToList();
        before = notifications.Notifications.Count;
        index.Reconcile(holder, fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);
        var activated = notifications.Since(before).ToList();

        Assert.True(AnnouncesTheReferrer(deactivated, refersEntry.Key, referrer.ToString()), "deactivated");
        Assert.True(AnnouncesTheReferrer(activated, refersEntry.Key, referrer.ToString()), "activated");
    }

    private static bool AnnouncesTheReferrer(IEnumerable<INotification> announced, PluginAddress plugin, string formKey) =>
        announced.Any(n => n is RecordIndexChangedNotification
            || n is RowsChangedNotification rows && rows.Plugin.Equals(plugin) && rows.Keys.Contains(formKey));

    [Fact]
    public void ANewLoadOrder_SaysEverythingChanged_AtTheSequenceItLandedOn()
    {
        using var fixture = new PluginFixtureBuilder("says-everything")
            .WithPlugin("Fixture.esp", mod => mod.Npcs.AddNew("FixtureNpc"), origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        var notifications = new InMemoryNotificationPublisher();

        using var index = Indexes.Reconciled(fixture, notifications: notifications);

        var everything = notifications.Notifications.OfType<RecordIndexChangedNotification>().Last();
        Assert.Equal(index.Sequence, everything.Sequence);
    }

    [Fact]
    public void TheLastNotificationOfALoad_CarriesTheSequenceItLeft()
    {
        using var fixture = new PluginFixtureBuilder("every-advance-announced")
            .WithPlugin("Fixture.esp", mod => mod.Npcs.AddNew("FixtureNpc"), origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(fixture, notifications: notifications);

        Assert.Equal(index.Sequence, notifications.Notifications.Select(SequenceOf).Max());
    }

    [Fact]
    public void AColdLoad_NamesEachPluginItReadWhole_AndSaysEverythingOnce()
    {
        using var fixture = new PluginFixtureBuilder("cold-load-names-plugins")
            .WithPlugin("One.esp", mod => mod.Npcs.AddNew("OneNpc"), origin: "OneMod")
            .WithPlugin("Two.esp", mod => mod.Npcs.AddNew("TwoNpc"), origin: "TwoMod")
            .BuildScattered()
            .CompiledPlugin();
        var notifications = new InMemoryNotificationPublisher();

        using var index = Indexes.Reconciled(fixture, notifications: notifications);

        Assert.Single(notifications.Notifications.OfType<RecordIndexChangedNotification>());
        foreach (var entry in fixture.Plugins) Assert.Contains(notifications.Notifications, Announcements.PluginChanged(entry));
    }

    [Fact]
    public void ABuildRewritingABinaryAlone_NamesItsPlugin_AndSaysNotEverything()
    {
        using var fixture = ACompiledPlugin("build-alone");
        var entry = fixture.Plugins.Single();
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(fixture, notifications: notifications);
        var before = notifications.Notifications.Count;

        PluginBinaries.Touch(entry.Path);
        index.NextCheckUntil(() => notifications.Since(before).Any(Announcements.PluginChanged(entry).Invoke), "the rewritten binary named");

        Assert.Contains(notifications.Since(before), Announcements.PluginChanged(entry));
        Assert.DoesNotContain(notifications.Since(before), n => n is RecordIndexChangedNotification);
    }

    [Fact]
    public void ABuildRewritingABinary_IsToldBesideRowsNamedInTheSameCheck()
    {
        using var fixture = ACompiledPlugin("build-beside-rows");
        var entry = fixture.Plugins.Single();
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(fixture, notifications: notifications);
        var before = notifications.Notifications.Count;

        PluginBinaries.Touch(entry.Path);
        var rows = entry.RenamedByHand(index);
        index.NextCheckUntil(() => notifications.Since(before).Any(Announcements.PluginChanged(entry).Invoke), "the rewritten binary named");

        Assert.Contains(notifications.Since(before), Announcements.PluginChanged(entry));
        Assert.Contains(notifications.Since(before), n => rows(n));
        Assert.DoesNotContain(notifications.Since(before), n => n is RecordIndexChangedNotification);
    }

    [Fact]
    public void AWholePluginReadAgainWithNoRecordMoved_NamesNoRowOfAnyPlugin()
    {
        using var fixture = TwoPluginsHoldingOneRecord("reread-moves-nothing");
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(fixture, notifications: notifications);
        var before = notifications.Notifications.Count;

        PluginBinaries.Touch(fixture.Plugins[1].Path);
        index.NextCheck();

        Assert.Contains(notifications.Since(before), Announcements.PluginChanged(fixture.Plugins[1]));
        Assert.DoesNotContain(notifications.Since(before), n => n is RowsChangedNotification);
    }

    [Fact]
    public void APluginNamedWhole_IsNotAlsoNamedByRows()
    {
        using var fixture = TwoPluginsHoldingOneRecord("whole-is-not-rows");
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(fixture, notifications: notifications);
        var before = notifications.Notifications.Count;

        PluginBinaries.Touch(fixture.Plugins[1].Path);
        index.NextCheck();

        Assert.DoesNotContain(notifications.Since(before), n => n is RowsChangedNotification rows && rows.Plugin.Equals(fixture.Plugins[1].Key));
    }

    private static ScatteredFixtureData ACompiledPlugin(string name) =>
        new PluginFixtureBuilder(name)
            .WithPlugin("Fixture.esp", mod => mod.Npcs.AddNew("FixtureNpc"), origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();

    private static ScatteredFixtureData TwoPluginsHoldingOneRecord(string name)
    {
        FormKey npc = default;
        return new PluginFixtureBuilder(name)
            .WithPlugin("Base.esm", mod => npc = mod.Npcs.AddNew("SharedNpc").FormKey, origin: "BaseMod")
            .WithPlugin("Over.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                mod.Npcs.Set(built.Single(m => m.ModKey.FileName == "Base.esm").Npcs.First(n => n.FormKey == npc).DeepCopy());
            }, origin: "OverMod")
            .BuildScattered();
    }

    private static long SequenceOf(INotification notification) => notification switch
    {
        RowsChangedNotification n => n.Sequence,
        PluginChangedNotification n => n.Sequence,
        RecordIndexChangedNotification n => n.Sequence,
        _ => 0,
    };
}
