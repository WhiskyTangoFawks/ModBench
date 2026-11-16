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
    public void EveryAdvanceOfTheSequence_IsAnnouncedAtOrAfterIt()
    {
        using var fixture = new PluginFixtureBuilder("every-advance-announced")
            .WithPlugin("Fixture.esp", mod => mod.Npcs.AddNew("FixtureNpc"), origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(fixture, notifications: notifications);

        Assert.Equal(index.Sequence, notifications.Notifications.Select(SequenceOf).Max());
    }

    private static long SequenceOf(INotification notification) => notification switch
    {
        RowsChangedNotification n => n.Sequence,
        PluginChangedNotification n => n.Sequence,
        RecordIndexChangedNotification n => n.Sequence,
        _ => 0,
    };
}
