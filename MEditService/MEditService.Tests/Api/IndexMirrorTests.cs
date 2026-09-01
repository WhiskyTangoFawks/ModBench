using MEditService.Api;
using MEditService.Bridge;
using MEditService.Core.Records;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>
/// ADR-0001: the runtime mirror, wired the way the composition root wires it — a real
/// load order, the real <see cref="ExternalChangeWatcher"/>, the real
/// <see cref="ExternalChangeLoadOrderHook"/> deciding which plugins get an index-mirror watch, and
/// <see cref="IndexMirror"/> turning each disk event into an index verb. What is asserted is what
/// the load order <i>answers</i> afterwards, while the backend runs, with no reload anywhere in the test.
/// </summary>
public sealed class IndexMirrorTests
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

    private static ExternalChangeWatcher StartMirroring(TrackedModFixture fixture)
    {
        var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
        var mirror = new IndexMirror(fixture.Mirror, NullLogger.Instance);
        watcher.IndexedBinaryChanged = mirror.Apply;
        ExternalChangeLoadOrderHook.RunAfterReconcile(
            fixture.Mirror.LoadOrder, fixture.Mirror.Index, watcher, NullLogger.Instance);
        return watcher;
    }

    /// <summary>Rewrites the fixture's binary with one extra NPC — a genuine content change by some
    /// other tool, not a touch.</summary>
    private static void RewriteBinaryWithExtraNpc(TrackedModFixture fixture, string editorId)
    {
        var mod = new Fallout4Mod(
            ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(TrackedModFixture.NpcEditorId);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(Path.Combine(fixture.ModFolder, TrackedModFixture.PluginName));
    }

    private static IReadOnlyList<string?> EditorIds(TrackedModFixture fixture, PluginKey key) =>
        [.. fixture.Mirror.Index!.At(RecordRef.Effective).GetDocuments(key).Select(d => d.EditorId)];

    // An untracked plugin's bytes move while the backend runs and the index follows, with no reload — the
    // whole point of extending the watcher past the tracked binaries.
    [Fact]
    public void AnUntrackedPluginChangedMidReconcile_IsReindexedWithNoReload()
    {
        using var fixture = TrackedModFixture.Untracked();
        using var watcher = StartMirroring(fixture);
        Assert.DoesNotContain("ArrivedExternally", EditorIds(fixture, fixture.Plugin));

        RewriteBinaryWithExtraNpc(fixture, "ArrivedExternally");

        WaitUntil(() => EditorIds(fixture, fixture.Plugin).Contains("ArrivedExternally"), TimeSpan.FromSeconds(10));
        Assert.Contains("ArrivedExternally", EditorIds(fixture, fixture.Plugin));
    }

    // A deletion removes the rows rather than re-reading a file that is not there: the index
    // holds exactly what exists, and the copy stops answering.
    [Fact]
    public void AnIndexedPluginDeletedMidReconcile_StopsAnswering()
    {
        using var fixture = TrackedModFixture.Untracked();
        using var watcher = StartMirroring(fixture);
        Assert.NotEmpty(EditorIds(fixture, fixture.Plugin));

        File.Delete(Path.Combine(fixture.ModFolder, TrackedModFixture.PluginName));

        WaitUntil(() => EditorIds(fixture, fixture.Plugin).Count == 0, TimeSpan.FromSeconds(10));
        Assert.Empty(EditorIds(fixture, fixture.Plugin));
        Assert.Null(fixture.Mirror.Index!.IndexedContentHash(fixture.Plugin));
    }

    // A tracked plugin's binary changing is a question for the
    // user (Absorb / Keep), never a silent re-index — its rows come from its source tree, so
    // re-reading the binary would overwrite the working tree with the compiled artifact.
    [Fact]
    public void ATrackedPluginChangedMidReconcile_AsksTheUser_AndIsNeverSilentlyReindexed()
    {
        using var fixture = TrackedModFixture.Tracked();
        var mirrored = new List<IndexedBinaryEvent>();
        using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
        watcher.IndexedBinaryChanged = e => { lock (mirrored) mirrored.Add(e); return true; };
        ExternalChangeLoadOrderHook.RunAfterReconcile(
            fixture.Mirror.LoadOrder, fixture.Mirror.Index, watcher, NullLogger.Instance);

        RewriteBinaryWithExtraNpc(fixture, "ChangedByXEdit");

        WaitUntil(() => watcher.Unanswered().Count > 0, TimeSpan.FromSeconds(5));
        Assert.NotEmpty(watcher.Unanswered());
        // Well past the debounce window, so "no mirror event" is a decision rather than a race: a
        // mirror watch that had been registered would have settled by now too.
        Thread.Sleep(500);
        lock (mirrored) Assert.Empty(mirrored);
        Assert.DoesNotContain("ChangedByXEdit", EditorIds(fixture, fixture.Plugin));
    }

    // A change to a plugin the index holds no rows for is not the mirror's business — there is
    // nothing to compare against and nothing to refresh.
    [Fact]
    public void RunAfterReconcile_MirrorsNothing_WhenThereIsNoLoadOrder()
    {
        using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));

        var offers = ExternalChangeLoadOrderHook.RunAfterReconcile(null, null, watcher, NullLogger.Instance);

        Assert.Empty(offers);
        Assert.Empty(watcher.Unanswered());
    }
}
