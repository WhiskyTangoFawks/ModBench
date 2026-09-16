using MEditService.Ports;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Records;

/// <summary>ADR-0014 invariant 2, the in-memory adapter: the same Index verbs the write API
/// reaches publish rows-changed through the port with no HTTP or SSE stream involved, proving the
/// port — not the transport — is the seam.</summary>
public sealed class RowsChangedNotificationTests
{
    [Fact]
    public void RefreshKeys_PublishesRowsChanged_WithTheKeyAndTheSequenceAfterTheWrite()
    {
        var notifications = new InMemoryNotificationPublisher();
        using var fixture = IndexedModFixture.Tracked(notifications);
        var formKey = fixture.Npc.ToString();
        var text = File.ReadAllText(fixture.NpcSourceFile);
        File.WriteAllText(fixture.NpcSourceFile, text.Replace(
            $"\"{IndexedModFixture.NpcEditorId}\"", "\"EditedName\"", StringComparison.Ordinal));

        fixture.Index.RefreshKeys(fixture.Plugin, [formKey]);

        var notification = Assert.Single(notifications.Notifications.OfType<RowsChangedNotification>());
        Assert.Equal(fixture.Plugin, notification.Plugin);
        Assert.Equal([formKey], notification.Keys);
        Assert.Equal(fixture.Index.Sequence, notification.Sequence);
    }

    // A container's document is one row plus every embedded child's, so naming only the key the
    // projector was handed leaves a panel open on a placed reference with nothing to re-read on.
    [Fact]
    public void ProjectingAContainersDocument_NamesTheContainerAndEveryEmbeddedChildWhoseRowsChanged()
    {
        var notifications = new InMemoryNotificationPublisher();
        using var fixture = new IndexedContainerFixture(notifications);
        var cell = fixture.EmbedCell.ToString();

        // A hand edit to a child inside its owner's document: the child has no file of its own, and
        // the projector is asked about the owner alone.
        var document = fixture.SourceFileContaining(ContainerModFixture.TemporaryRefEditorId);
        File.WriteAllText(
            document,
            File.ReadAllText(document).Replace(
                $"\"{ContainerModFixture.TemporaryRefEditorId}\"", "\"RenamedByHand\"", StringComparison.Ordinal));

        fixture.Index.RefreshKeys(fixture.Plugin, [cell]);

        var rowsChanged = notifications.Notifications.OfType<RowsChangedNotification>().Last();
        Assert.Contains(cell, rowsChanged.Keys);
        Assert.Contains(fixture.TemporaryRef.ToString(), rowsChanged.Keys);
        // The sibling nobody touched is not named: a notification that names every child of every
        // refreshed container is a broadcast again.
        Assert.DoesNotContain(fixture.PersistentRef.ToString(), rowsChanged.Keys);
    }
}
