using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class RowsChangedNotificationTests
{
    [Fact]
    public void AHandEditedDocument_PublishesRowsChanged_WithTheKeyAndTheSequenceAfterTheWrite()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("rows-changed")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        var entry = fixture.Plugins.Single();
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(fixture, notifications: notifications);
        var formKey = npc.ToString();
        entry.HandEdit(index.DocumentOf(formKey, entry.Key), "\"FixtureNpc\"", "\"EditedName\"");

        index.NextCheck();

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(entry.Key, notification.Plugin);
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
            .CompiledPlugin();
        var entry = fixture.Plugins.Single();
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(fixture, notifications: notifications);
        var formKey = npc.ToString();
        var documentDeletedByHandWhereGitCannotNameTheKey = entry.SourceFileOf(index.DocumentOf(formKey, entry.Key));
        File.Delete(documentDeletedByHandWhereGitCannotNameTheKey);

        index.NextCheck();

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(entry.Key, notification.Plugin);
        Assert.Equal([formKey], notification.Keys);
        Assert.Equal(index.Sequence, notification.Sequence);
        Assert.Null(index.CopyIn(formKey, entry.Key));
    }

    [Fact]
    public void ValidatingAKeyNeitherRefHolds_NamesItAndEveryRowThatMoved_AndNoOtherRow()
    {
        var (fixture, entry, notifications, index, moved, still) = TwoNpcs("rows-changed-gained");
        using var _ = fixture;
        using var __ = index;
        var gained = GainACopyOfARecordUnderAFormKeyNeitherRefHolds(entry, index, moved.ToString());
        entry.RenameByHand(index.DocumentOf(moved.ToString(), entry.Key), "EditedNpc");

        index.NextCheck();

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(entry.Key, notification.Plugin);
        Assert.Equal([moved.ToString(), gained], notification.Keys.Order(StringComparer.Ordinal));
        Assert.DoesNotContain(still.ToString(), notification.Keys);
        Assert.Equal(index.Sequence, notification.Sequence);
        Assert.Empty(notifications.Notifications.OfType<PluginChangedNotification>());
        Assert.NotNull(index.CopyIn(gained, entry.Key));
    }

    [Fact]
    public void ValidatingAPluginThatGainedADocumentNoCommitFiled_PublishesRowsChangedNamingIt_NotPluginChanged()
    {
        var (fixture, entry, notifications, index, moved, _) = TwoNpcs("rows-changed-validate-gained");
        using var __ = fixture;
        using var ___ = index;
        var gained = GainACopyOfARecordUnderAFormKeyNeitherRefHolds(entry, index, moved.ToString());

        index.NextCheck();

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal([gained], notification.Keys);
        Assert.Empty(notifications.Notifications.OfType<PluginChangedNotification>());
        Assert.NotNull(index.CopyIn(gained, entry.Key));
    }

    [Fact]
    public void ADocumentSavedAfterTheCheckReadTheStamps_IsNotNamedUntilACheckHoldsItsRow()
    {
        var source = new CountingTreeSource(TestAdapters.Source());
        var notifications = new InMemoryNotificationPublisher();
        FormKey template = default;
        using var fixture = new PluginFixtureBuilder("rows-changed-saved-mid-check")
            .WithPlugin("Fixture.esp", mod => template = mod.Npcs.AddNew("TemplateNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        var entry = fixture.Plugins.Single();
        using var index = Indexes.Reconciled(fixture, notifications: notifications, source: source);
        var gained = $"000F00:{entry.Name}";
        var heldWhenNamed = new System.Collections.Concurrent.ConcurrentQueue<bool>();
        notifications.OnPublish = n =>
        {
            if (Announcements.RowsChanged(gained)(n)) heldWhenNamed.Enqueue(index.CopyIn(gained, entry.Key) is not null);
        };
        source.BeforeNextGitStatus = () => GainACopyOfARecordUnderAFormKeyNeitherRefHolds(entry, index, template.ToString());

        var asked = source.GitStatusAsked;
        index.NextCheckUnsettledUntil(() => source.GitStatusAsked > asked, "git asked what the tree changed");
        index.NextCheckUntil(() => heldWhenNamed.Count > 0, "the gained record named");

        Assert.All(heldWhenNamed, Assert.True);
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
            .CompiledPlugin();
        var notifications = new InMemoryNotificationPublisher();
        var index = Indexes.Reconciled(fixture, notifications: notifications);
        return (fixture, fixture.Plugins.Single(), notifications, index, moved, still);
    }

    private static string GainACopyOfARecordUnderAFormKeyNeitherRefHolds(LoadOrderEntry entry, OpenedIndex index, string template)
    {
        var gained = $"000F00:{entry.Name}";
        var document = index.DocumentOf(template, entry.Key);
        SourceMods.RepositoryOf(entry).Put(entry.Key, new SourceDocument(
            gained, document.RecordType, "GainedNpc",
            index.BodyOf(template, entry.Key).Replace(template, gained, StringComparison.Ordinal)
                .Replace($"\"{document.EditorId}\"", "\"GainedNpc\"", StringComparison.Ordinal))).Wrote();
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

        fixture.Index.NextCheck();

        var rowsChanged = notifications.Notifications.OfType<RowsChangedNotification>().Last();
        Assert.Contains(fixture.EmbedCell, rowsChanged.Keys);
        Assert.Contains(fixture.TemporaryRef, rowsChanged.Keys);
        Assert.DoesNotContain(fixture.PersistentRef, rowsChanged.Keys);
    }
}
