using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using MEditService.Watcher;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Bridge;

/// <summary>Wired the way the composition root wires it (ADR-0009); what is asserted is what the
/// load order answers afterwards, while the backend runs, with no reload anywhere.</summary>
public sealed class IndexedBinaryWatchTests
{
    private static void WaitUntil(Func<bool> condition, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return;
            Thread.Sleep(20);
        }
    }

    private static ModFolderWatcher StartWatching(IndexedModFixture fixture, INotificationPublisher? notifications = null)
    {
        var watcher = TestWatcher.Over(
            fixture.Holder, fixture.Index, notifications ?? new InMemoryNotificationPublisher(),
            TimeSpan.FromMilliseconds(100));
        watcher.Rearm(fixture.Holder.Current);
        return watcher;
    }

    private static void RewriteBinaryWithExtraNpc(IndexedModFixture fixture, string editorId)
    {
        var mod = new Fallout4Mod(
            ModKey.FromFileName(IndexedModFixture.PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(IndexedModFixture.NpcEditorId);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(Path.Combine(fixture.ModFolder, IndexedModFixture.PluginName));
    }

    private static IReadOnlyList<string?> EditorIds(IndexedModFixture fixture, PluginKey key) =>
        [.. fixture.Index.Projected().GetDocuments(key).Select(d => d.EditorId)];

    // An untracked plugin's bytes move while the backend runs and the index follows, with no reload — the
    // whole point of extending the watcher past the tracked binaries.
    [Fact]
    public void AnUntrackedPluginChangedMidReconcile_IsReindexedWithNoReload()
    {
        using var fixture = IndexedModFixture.Untracked();
        using var watcher = StartWatching(fixture);
        Assert.DoesNotContain("ArrivedExternally", EditorIds(fixture, fixture.Plugin));

        RewriteBinaryWithExtraNpc(fixture, "ArrivedExternally");

        WaitUntil(() => EditorIds(fixture, fixture.Plugin).Contains("ArrivedExternally"), TimeSpan.FromSeconds(10));
        Assert.Contains("ArrivedExternally", EditorIds(fixture, fixture.Plugin));
    }

    // ADR-0014: the plugin watcher's own re-index is exactly "whenever the plugin watcher
    // re-indexes a binary" — the trigger this notification names.
    [Fact]
    public void AnUntrackedPluginChangedMidReconcile_PublishesPluginChanged()
    {
        using var fixture = IndexedModFixture.Untracked();
        var notifications = new InMemoryNotificationPublisher();
        using var watcher = StartWatching(fixture, notifications);

        RewriteBinaryWithExtraNpc(fixture, "ArrivedExternally");

        WaitUntil(() => notifications.Notifications.Count > 0, TimeSpan.FromSeconds(10));
        var changed = Assert.IsType<PluginChangedNotification>(Assert.Single(notifications.Notifications));
        Assert.Equal(fixture.Plugin, changed.Plugin);
    }

    // A deletion removes the rows rather than re-reading a file that is not there: the index
    // holds exactly what exists, and the copy stops answering.
    [Fact]
    public void AnIndexedPluginDeletedMidReconcile_StopsAnswering()
    {
        using var fixture = IndexedModFixture.Untracked();
        using var watcher = StartWatching(fixture);
        Assert.NotEmpty(EditorIds(fixture, fixture.Plugin));

        File.Delete(Path.Combine(fixture.ModFolder, IndexedModFixture.PluginName));

        WaitUntil(() => EditorIds(fixture, fixture.Plugin).Count == 0, TimeSpan.FromSeconds(10));
        Assert.Empty(EditorIds(fixture, fixture.Plugin));
        Assert.Null(fixture.Index.Store!.IndexedContentHash(fixture.Plugin));
    }

    // A tracked plugin's binary changing is a question for the
    // user (Absorb / Keep), never a silent re-index — its rows come from its source tree, so
    // re-reading the binary would overwrite the working tree with the compiled artifact.
    [Fact]
    public void ATrackedPluginChangedMidReconcile_AsksTheUser_AndIsNeverSilentlyReindexed()
    {
        using var fixture = IndexedModFixture.Tracked();
        var index = new RecordingRefreshIndex();
        using var watcher = TestWatcher.Over(
            fixture.Holder, index, new InMemoryNotificationPublisher(), TimeSpan.FromMilliseconds(100));
        watcher.Rearm(fixture.Holder.Current);

        RewriteBinaryWithExtraNpc(fixture, "ChangedByXEdit");

        WaitUntil(() => SourceRepository.UnansweredExternalChange(fixture.ModFolder) != null, TimeSpan.FromSeconds(5));
        Assert.NotNull(SourceRepository.UnansweredExternalChange(fixture.ModFolder));
        // Well past the debounce window, so "no re-index" is a decision rather than a race.
        Thread.Sleep(500);
        Assert.Empty(index.Of("reindex"));
        Assert.DoesNotContain("ChangedByXEdit", EditorIds(fixture, fixture.Plugin));
    }

    // A change to a plugin the index holds no rows for is not this route's business — there is
    // nothing to compare against and nothing to refresh.
    [Fact]
    public void Rearm_WatchesNothing_WhenThereIsNoLoadOrder()
    {
        var holder = new LoadOrderHolder();
        using var noLoadOrder = new IndexProjector(holder, MutagenPluginAdapter.Instance, SharedSchemaReflector.Instance);
        using var watcher = TestWatcher.Over(
            holder, noLoadOrder, new InMemoryNotificationPublisher(), TimeSpan.FromMilliseconds(100));

        var offers = watcher.Rearm(holder.Current);

        Assert.Empty(offers);
    }
}
