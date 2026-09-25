using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

/// <summary>ADR-0014 invariant 2, the in-memory adapter: the Index verbs the write API reaches
/// publish rows-changed through the port with no HTTP or SSE stream involved, proving the port —
/// not the transport — is the seam.</summary>
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

        index.RefreshKeys(entry.KeyOf(), [formKey]);

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(entry.KeyOf(), notification.Plugin);
        Assert.Equal([formKey], notification.Keys);
        Assert.Equal(index.Sequence, notification.Sequence);
    }

    // Where a deletion lands when the watch could not name its key: a burst of deletes wider than one
    // batch, an overflow, a ref move in the same window, or a document no commit filed.
    [Fact]
    public void ValidatingACopyWhoseDocumentWasDeleted_PublishesRowsChangedNamingTheRecord_AndReadsLoseIt()
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
        File.Delete(entry.SourceFileOf(index.RequireReads().DocumentOf(formKey, entry.KeyOf())));

        index.ValidateIndex(entry.KeyOf());

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(entry.KeyOf(), notification.Plugin);
        Assert.Equal([formKey], notification.Keys);
        Assert.Equal(index.Sequence, notification.Sequence);
        Assert.Null(index.RequireReads().GetDocument(formKey, entry.KeyOf()));
    }

    // The tree gained a record, as an edit of a FormID or a create leaves it: read again whole, and
    // named by the rows that moved (edit-record.md, Hand-off), never by the plugin.
    [Fact]
    public void RefreshKeys_ForAKeyNeitherRefHolds_NamesItAndEveryRowThatMoved_AndNoOtherRow()
    {
        var (fixture, entry, notifications, index, moved, still) = TwoNpcs("rows-changed-gained");
        using var _ = fixture;
        using var __ = index;
        var gained = GainARecord(entry, index, moved.ToString());
        entry.HandEdit(index.RequireReads().DocumentOf(moved.ToString(), entry.KeyOf()), "\"MovedNpc\"", "\"EditedNpc\"");

        index.RefreshKeys(entry.KeyOf(), [gained]);

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(entry.KeyOf(), notification.Plugin);
        Assert.Equal([moved.ToString(), gained], notification.Keys.Order(StringComparer.Ordinal));
        Assert.DoesNotContain(still.ToString(), notification.Keys);
        Assert.Equal(index.Sequence, notification.Sequence);
        Assert.Empty(notifications.Notifications.OfType<PluginChangedNotification>());
        Assert.NotNull(index.RequireReads().GetDocument(gained, entry.KeyOf()));
    }

    // Where a gained record lands when the watch could not name its key: a new document no commit
    // filed. The validate re-derives the copy whole, and still names the rows.
    [Fact]
    public void ValidatingACopyThatGainedADocument_PublishesRowsChangedNamingIt_NotPluginChanged()
    {
        var (fixture, entry, notifications, index, moved, _) = TwoNpcs("rows-changed-validate-gained");
        using var __ = fixture;
        using var ___ = index;
        var gained = GainARecord(entry, index, moved.ToString());

        var report = Assert.Single(index.ValidateIndex(entry.KeyOf()));

        Assert.True(report.NeedsRebuild);
        Assert.Equal([gained], report.ChangedKeys);
        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal([gained], notification.Keys);
        Assert.Empty(notifications.Notifications.OfType<PluginChangedNotification>());
        Assert.NotNull(index.RequireReads().GetDocument(gained, entry.KeyOf()));
    }

    private static (ScatteredFixtureData Fixture, LoadOrderEntry Entry, InMemoryNotificationPublisher Notifications,
        Indexer Index, FormKey Moved, FormKey Still) TwoNpcs(string name)
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

    // A copy of an existing document under a FormKey neither ref holds, put the way the write side
    // puts one.
    private static string GainARecord(LoadOrderEntry entry, Indexer index, string template)
    {
        var gained = $"000F00:{entry.Name}";
        var document = index.RequireReads().DocumentOf(template, entry.KeyOf());
        TrackedMods.RepositoryOf(entry).Put(entry.KeyOf(), new SourceDocument(
            gained, document.RecordType, "GainedNpc",
            document.Body.Require().Replace(template, gained, StringComparison.Ordinal)
                .Replace($"\"{document.EditorId}\"", "\"GainedNpc\"", StringComparison.Ordinal)));
        return gained;
    }

    // A container's document is one row plus every embedded child's, so naming only the key the
    // Indexer was handed leaves a panel open on a placed reference with nothing to re-read on.
    [Fact]
    public void ProjectingAContainersDocument_NamesTheContainerAndEveryEmbeddedChildWhoseRowsChanged()
    {
        var notifications = new InMemoryNotificationPublisher();
        using var fixture = new IndexedContainerMod(notifications);

        // A hand edit to a child inside its owner's document: the child has no file of its own, and
        // the Indexer is asked about the owner alone.
        var document = fixture.Mod.SourceFileContaining(ContainerModPlugin.TemporaryRefEditorId);
        File.WriteAllText(
            document,
            File.ReadAllText(document).Replace(
                $"\"{ContainerModPlugin.TemporaryRefEditorId}\"", "\"RenamedByHand\"", StringComparison.Ordinal));

        fixture.Index.RefreshKeys(fixture.Plugin, [fixture.EmbedCell]);

        var rowsChanged = notifications.Notifications.OfType<RowsChangedNotification>().Last();
        Assert.Contains(fixture.EmbedCell, rowsChanged.Keys);
        Assert.Contains(fixture.TemporaryRef, rowsChanged.Keys);
        // The sibling nobody touched is not named: a notification that names every child of every
        // refreshed container is a broadcast again.
        Assert.DoesNotContain(fixture.PersistentRef, rowsChanged.Keys);
    }
}
