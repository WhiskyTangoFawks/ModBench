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
/// #587 / ADR-0001: the runtime mirror, wired the way the composition root wires it — a real
/// session, the real <see cref="ExternalChangeWatcher"/>, the real
/// <see cref="ExternalChangeSessionHook"/> deciding which plugins get an index-mirror watch, and
/// <see cref="IndexMirror"/> turning each disk event into an index verb. What is asserted is what
/// the session <i>answers</i> afterwards, mid-session, with no reload anywhere in the test.
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
        var mirror = new IndexMirror(fixture.Sessions, NullLogger.Instance);
        watcher.IndexedBinaryChanged = mirror.Apply;
        ExternalChangeSessionHook.RunAfterLoad(
            fixture.Sessions.Session, fixture.Sessions.Index, watcher, NullLogger.Instance);
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
        [.. fixture.Sessions.Index!.GetDocuments(key).Select(d => d.EditorId)];

    // AC1. An untracked plugin's bytes move mid-session and the index follows, with no reload — the
    // whole point of extending the watcher past the tracked binaries.
    [Fact]
    public void AnUntrackedPluginChangedMidSession_IsReindexedWithNoReload()
    {
        using var fixture = TrackedModFixture.Untracked();
        using var watcher = StartMirroring(fixture);
        Assert.DoesNotContain("ArrivedExternally", EditorIds(fixture, fixture.Plugin));

        RewriteBinaryWithExtraNpc(fixture, "ArrivedExternally");

        WaitUntil(() => EditorIds(fixture, fixture.Plugin).Contains("ArrivedExternally"), TimeSpan.FromSeconds(10));
        Assert.Contains("ArrivedExternally", EditorIds(fixture, fixture.Plugin));
    }

    // AC2. A deletion removes the rows rather than re-reading a file that is not there: the index
    // holds exactly what exists, and the copy stops answering.
    [Fact]
    public void AnIndexedPluginDeletedMidSession_StopsAnswering()
    {
        using var fixture = TrackedModFixture.Untracked();
        using var watcher = StartMirroring(fixture);
        Assert.NotEmpty(EditorIds(fixture, fixture.Plugin));

        File.Delete(Path.Combine(fixture.ModFolder, TrackedModFixture.PluginName));

        WaitUntil(() => EditorIds(fixture, fixture.Plugin).Count == 0, TimeSpan.FromSeconds(10));
        Assert.Empty(EditorIds(fixture, fixture.Plugin));
        Assert.Null(fixture.Sessions.Index!.IndexedContentHash(fixture.Plugin));
    }

    // AC4. A tracked plugin keeps the behaviour it had: its binary changing is a question for the
    // user (Absorb / Keep), never a silent re-index — its rows come from its source tree, so
    // re-reading the binary would overwrite the working tree with the compiled artifact.
    [Fact]
    public void ATrackedPluginChangedMidSession_AsksTheUser_AndIsNeverSilentlyReindexed()
    {
        using var fixture = TrackedModFixture.Tracked();
        var mirrored = new List<IndexedBinaryEvent>();
        using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
        watcher.IndexedBinaryChanged = e => { lock (mirrored) mirrored.Add(e); return true; };
        ExternalChangeSessionHook.RunAfterLoad(
            fixture.Sessions.Session, fixture.Sessions.Index, watcher, NullLogger.Instance);

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
    public void RunAfterLoad_MirrorsNothing_WhenThereIsNoSession()
    {
        using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));

        var offers = ExternalChangeSessionHook.RunAfterLoad(null, null, watcher, NullLogger.Instance);

        Assert.Empty(offers);
        Assert.Empty(watcher.Unanswered());
    }
}
