using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class CompiledPluginProjectionTests
{
    [Fact]
    public void ARowsChangedNotification_IsPublishedOnceItsRowsLanded_AndNamesTheSequenceItLandedOn()
    {
        FormKey formKey = default;
        using var fixture = new PluginFixtureBuilder("compiled-plugin-projection")
            .WithPlugin("Fixture.esp", mod => formKey = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        var mod = fixture.Plugins.Single();
        var npc = formKey.ToString();
        var notifications = new InMemoryNotificationPublisher();
        OpenedIndex? opened = null;
        var seenWhenPublished = new List<(long Sequence, string? EditorId)>();
        notifications.OnPublish = n =>
        {
            if (n is RowsChangedNotification && opened is { } held) seenWhenPublished.Add((held.Sequence, held.CopyIn(npc, mod.Key)?.EditorId));
        };
        using var index = opened = Indexes.Reconciled(fixture, notifications: notifications);
        mod.HandEdit(index.DocumentOf(npc, mod.Key), "\"FixtureNpc\"", "\"RenamedByHand\"");
        PluginBinaries.Touch(mod.Path);

        index.NextCheckUntil(() => notifications.Notifications.Any(Announcements.RowsChanged(npc).Invoke), "the rows changed announcement");

        var landed = notifications.Notifications.OfType<RowsChangedNotification>().Single();
        Assert.Contains(npc, landed.Keys);
        Assert.Equal(index.Sequence, landed.Sequence);
        Assert.Equal((landed.Sequence, "RenamedByHand"), seenWhenPublished.Single());
    }
}
