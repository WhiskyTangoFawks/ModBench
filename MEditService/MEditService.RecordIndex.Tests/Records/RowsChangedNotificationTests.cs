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
    public void ADeletedRecord_IsAnnouncedWithTheRecordsOfCompiledPluginsThatReferToIt()
    {
        FormKey target = default;
        FormKey referrer = default;
        using var fixture = new PluginFixtureBuilder("rows-changed-referrers")
            .WithPlugin("Fixture.esp", mod =>
            {
                target = mod.Npcs.AddNew("Target").FormKey;
                var referring = mod.Npcs.AddNew("Referrer");
                referring.Race.SetTo(target);
                referrer = referring.FormKey;
                mod.Npcs.AddNew("Bystander");
            }, origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        var entry = fixture.Plugins.Single();
        var notifications = new InMemoryNotificationPublisher();
        using var index = Indexes.Reconciled(fixture, notifications: notifications);
        File.Delete(entry.SourceFileOf(index.DocumentOf(target.ToString(), entry.Key)));

        index.NextCheck();

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(new[] { target.ToString(), referrer.ToString() }.Order(StringComparer.Ordinal), notification.Keys.Order(StringComparer.Ordinal));
    }

    private static (ScatteredFixtureData Fixture, LoadOrderEntry Entry, InMemoryNotificationPublisher Notifications, OpenedIndex Index, FormKey Target, FormKey Referrer) ReferrerOfATarget(string name, string? refersTo = null)
    {
        FormKey target = default, referrer = default;
        var fixture = new PluginFixtureBuilder(name)
            .WithPlugin("Fixture.esp", mod =>
            {
                target = mod.Npcs.AddNew("Target").FormKey;
                var referring = mod.Npcs.AddNew("Referrer");
                referring.Race.SetTo(refersTo is null ? target : FormKey.Factory(refersTo));
                referrer = referring.FormKey;
            }, origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        var notifications = new InMemoryNotificationPublisher();
        var index = Indexes.Reconciled(fixture, notifications: notifications);
        return (fixture, fixture.Plugins.Single(), notifications, index, target, referrer);
    }

    [Fact]
    public void AContentEditOfARecord_NamesNoRecordThatReferToIt()
    {
        var (fixture, entry, notifications, index, target, referrer) = ReferrerOfATarget("rows-changed-edit-referrers");
        using var _ = fixture;
        using var __ = index;
        entry.HandEdit(index.DocumentOf(target.ToString(), entry.Key), "\"Target\"", "\"Edited\"");

        index.NextCheck();

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal([target.ToString()], notification.Keys);
        Assert.DoesNotContain(referrer.ToString(), notification.Keys);
    }

    [Fact]
    public void ARecordAdded_IsAnnouncedWithTheRecordsThatReferToItBeforeItExisted()
    {
        const string Added = "000F00:Fixture.esp";
        var (fixture, entry, notifications, index, target, referrer) = ReferrerOfATarget("rows-changed-add-referrers", Added);
        using var _ = fixture;
        using var __ = index;
        GainACopyOfARecordUnderAFormKeyNeitherRefHolds(entry, index, target.ToString());

        index.NextCheck();

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(new[] { Added, referrer.ToString() }.Order(StringComparer.Ordinal), notification.Keys.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void ValidatingAKeyNeitherRefHolds_NamesItAndEveryRowThatMoved_AndNoOtherRow()
    {
        var (fixture, entry, notifications, index, moved, still) = TwoNpcs("rows-changed-gained");
        using var _ = fixture;
        using var __ = index;
        var gained = GainACopyOfARecordUnderAFormKeyNeitherRefHolds(entry, index, moved.ToString());
        entry.RenameByHand(index.DocumentOf(moved.ToString(), entry.Key), "EditedNpc");

        var loaded = notifications.Notifications.Count;

        index.NextCheck();

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(entry.Key, notification.Plugin);
        Assert.Equal([moved.ToString(), gained], notification.Keys.Order(StringComparer.Ordinal));
        Assert.DoesNotContain(still.ToString(), notification.Keys);
        Assert.Equal(index.Sequence, notification.Sequence);
        Assert.Empty(notifications.Since(loaded).OfType<PluginChangedNotification>());
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
        entry.Git("commit", "--allow-empty", "--quiet", "-m", "Moves HEAD, so the next check asks git again");

        var asked = source.GitStatusAsked;
        index.NextCheckUnsettledUntil(() => source.GitStatusAsked > asked, "git asked what the tree changed");
        index.NextCheckUntil(() => !heldWhenNamed.IsEmpty, "the gained record named");

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
