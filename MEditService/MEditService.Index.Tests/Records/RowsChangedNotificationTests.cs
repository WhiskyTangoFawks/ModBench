using MEditService.Index.Tests.TestSupport;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class RowsChangedNotificationTests
{
    [Fact]
    public void RefreshKeys_PublishesRowsChanged_WithTheKeyAndTheSequenceAfterTheWrite()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("rows-changed")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        var entry = fixture.Plugins.Single();
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(fixture, notifications: notifications);
        var formKey = npc.ToString();
        entry.HandEdit(index.RequireReads().DocumentOf(formKey, entry.KeyOf()), "\"FixtureNpc\"", "\"EditedName\"");

        index.NextSnapshot();

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(entry.KeyOf(), notification.Plugin);
        Assert.Equal([formKey], notification.Keys);
        Assert.Equal(index.Sequence, notification.Sequence);
    }

    [Fact]
    public void ValidatingAPluginWhoseDocumentWasDeleted_PublishesRowsChangedNamingTheRecord_AndReadsLoseIt()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("rows-changed-delete")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        var entry = fixture.Plugins.Single();
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(fixture, notifications: notifications);
        var formKey = npc.ToString();
        var documentDeletedByHandWhereGitCannotNameTheKey = entry.SourceFileOf(index.RequireReads().DocumentOf(formKey, entry.KeyOf()));
        File.Delete(documentDeletedByHandWhereGitCannotNameTheKey);

        index.NextSnapshot();

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(entry.KeyOf(), notification.Plugin);
        Assert.Equal([formKey], notification.Keys);
        Assert.Equal(index.Sequence, notification.Sequence);
        Assert.Null(index.RequireReads().GetDocument(formKey, entry.KeyOf()));
    }

    [Fact]
    public void RefreshKeys_ForAKeyNeitherRefHolds_NamesItAndEveryRowThatMoved_AndNoOtherRow()
    {
        var (fixture, entry, notifications, index, moved, still) = TwoNpcs("rows-changed-gained");
        using var _ = fixture;
        using var __ = index;
        var gained = GainACopyOfARecordUnderAFormKeyNeitherRefHolds(entry, index, moved.ToString());
        entry.HandEdit(index.RequireReads().DocumentOf(moved.ToString(), entry.KeyOf()), "\"MovedNpc\"", "\"EditedNpc\"");

        index.NextSnapshot();

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(entry.KeyOf(), notification.Plugin);
        Assert.Equal([moved.ToString(), gained], notification.Keys.Order(StringComparer.Ordinal));
        Assert.DoesNotContain(still.ToString(), notification.Keys);
        Assert.Equal(index.Sequence, notification.Sequence);
        Assert.Empty(notifications.Notifications.OfType<PluginChangedNotification>());
        Assert.NotNull(index.RequireReads().GetDocument(gained, entry.KeyOf()));
    }

    [Fact]
    public void ValidatingAPluginThatGainedADocumentNoCommitFiled_PublishesRowsChangedNamingIt_NotPluginChanged()
    {
        var (fixture, entry, notifications, index, moved, _) = TwoNpcs("rows-changed-validate-gained");
        using var __ = fixture;
        using var ___ = index;
        var gained = GainACopyOfARecordUnderAFormKeyNeitherRefHolds(entry, index, moved.ToString());

        index.NextSnapshot();

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal([gained], notification.Keys);
        Assert.Empty(notifications.Notifications.OfType<PluginChangedNotification>());
        Assert.NotNull(index.RequireReads().GetDocument(gained, entry.KeyOf()));
    }

    private static (ScatteredFixtureData Fixture, LoadOrderEntry Entry, InMemoryNotificationPublisher Notifications,
        OpenedIndex Index, FormKey Moved, FormKey Still) TwoNpcs(string name)
    {
        FormKey moved = default, still = default;
        var fixture = new PluginFixtureBuilder(name)
            .WithPlugin("Fixture.esp", mod =>
            {
                moved = mod.Npcs.AddNew("MovedNpc").FormKey;
                still = mod.Npcs.AddNew("StillNpc").FormKey;
            }, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        var notifications = new InMemoryNotificationPublisher();
        var index = Indexes.Reconciled(fixture, notifications: notifications);
        return (fixture, fixture.Plugins.Single(), notifications, index, moved, still);
    }

    private static string GainACopyOfARecordUnderAFormKeyNeitherRefHolds(LoadOrderEntry entry, OpenedIndex index, string template)
    {
        var gained = $"000F00:{entry.Name}";
        var document = index.RequireReads().DocumentOf(template, entry.KeyOf());
        TrackedMods.RepositoryOf(entry).Put(entry.KeyOf(), new SourceDocument(
            gained, document.RecordType, "GainedNpc",
            document.Body.Require().Replace(template, gained, StringComparison.Ordinal)
                .Replace($"\"{document.EditorId}\"", "\"GainedNpc\"", StringComparison.Ordinal)));
        return gained;
    }

    [Fact]
    public void ProjectingAContainersDocument_NamesTheContainerAndTheEmbeddedChildWhoseRowsChanged_AndNotTheUntouchedSibling()
    {
        var notifications = new InMemoryNotificationPublisher();
        using var fixture = new IndexedContainerMod(notifications);

        var ownersDocumentHoldingTheChildWithNoFileOfItsOwn = fixture.Mod.SourceFileContaining(ContainerModPlugin.TemporaryRefEditorId);
        File.WriteAllText(
            ownersDocumentHoldingTheChildWithNoFileOfItsOwn,
            File.ReadAllText(ownersDocumentHoldingTheChildWithNoFileOfItsOwn).Replace(
                $"\"{ContainerModPlugin.TemporaryRefEditorId}\"", "\"RenamedByHand\"", StringComparison.Ordinal));

        fixture.Index.NextSnapshot();

        var rowsChanged = notifications.Notifications.OfType<RowsChangedNotification>().Last();
        Assert.Contains(fixture.EmbedCell, rowsChanged.Keys);
        Assert.Contains(fixture.TemporaryRef, rowsChanged.Keys);
        Assert.DoesNotContain(fixture.PersistentRef, rowsChanged.Keys);
    }
}
