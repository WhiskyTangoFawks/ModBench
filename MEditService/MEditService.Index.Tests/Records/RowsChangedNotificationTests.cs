using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
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
