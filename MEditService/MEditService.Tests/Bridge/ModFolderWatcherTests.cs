using System.Text.Json;
using MEditService.Bridge;
using MEditService.Core.Edits;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Bridge;

/// <summary>ADR-0046: one recursive watcher per mod folder, tracked or not — classification,
/// the indexed-binary route and per-mod batching, retired from ExternalChangeWatcherTests,
/// IndexedBinaryWatchTests and SourceChangeWatcherTests respectively.</summary>
public sealed class ModFolderWatcherTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-modwatch-").FullName;

    private static string Track(string modFolder, string plugin, byte[] parkedBinary)
    {
        var files = new[] { new PristineFile($"source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray()) };
        var trailers = new TrackProvenance(null, null, new Dictionary<string, string> { [plugin] = "unused-at-track-time" });
        SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);

        var pluginPath = Path.Combine(modFolder, plugin);
        File.WriteAllBytes(pluginPath, parkedBinary);
        var binarySha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(parkedBinary));
        SourceRepository.ParkCompileSnapshot(modFolder, plugin, atRef: null, binarySha256);
        return pluginPath;
    }

    private static void WaitUntil(Func<bool> condition, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return;
            Thread.Sleep(20);
        }
    }

    // ---- classification: retired from ExternalChangeWatcherTests ----

    [Fact]
    public void Watch_QueuesAnUnansweredExternalChange_WhenTheWatchedBinaryChanges()
    {
        var modFolder = NewModFolder();
        try
        {
            var pluginPath = Track(modFolder, "Test.esp", "original"u8.ToArray());
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(100));
            watcher.Watch(modFolder, "Test.esp", pluginPath);

            File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());

            WaitUntil(() => watcher.Unanswered().Count > 0, TimeSpan.FromSeconds(3));

            var unanswered = Assert.Single(watcher.Unanswered());
            Assert.Equal(modFolder, unanswered.ModFolder);
            Assert.Equal(["Test.esp"], unanswered.Classification.Plugins);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Watch_SetsTheExternalChangeDeferralMarker_AssoonAsAQuestionIsQueued()
    {
        var modFolder = NewModFolder();
        try
        {
            var pluginPath = Track(modFolder, "Test.esp", "original"u8.ToArray());
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(100));
            watcher.Watch(modFolder, "Test.esp", pluginPath);
            Assert.Null(ExternalChangeDeferral.Unanswered(modFolder));

            File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());
            WaitUntil(() => watcher.Unanswered().Count > 0, TimeSpan.FromSeconds(3));

            var question = ExternalChangeDeferral.Unanswered(modFolder);
            Assert.NotNull(question);
            Assert.Contains("Test.esp", question, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Watch_DoesNotQueueAnythingBeforeTheQuietWindowElapses()
    {
        var modFolder = NewModFolder();
        try
        {
            var pluginPath = Track(modFolder, "Test.esp", "original"u8.ToArray());
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(300));
            watcher.Watch(modFolder, "Test.esp", pluginPath);

            File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());
            Thread.Sleep(30); // well inside the 300ms quiet window

            Assert.Empty(watcher.Unanswered());
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Watch_DoesNotQueueASelfEcho()
    {
        var modFolder = NewModFolder();
        try
        {
            var binary = "original"u8.ToArray();
            var pluginPath = Track(modFolder, "Test.esp", binary);
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(100));
            watcher.Watch(modFolder, "Test.esp", pluginPath);

            // Re-writing the exact bytes the parked ref already names — Save & Compile's own write,
            // not an external change.
            File.WriteAllBytes(pluginPath, binary);
            Thread.Sleep(400);

            Assert.Empty(watcher.Unanswered());
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Watch_DoesNotQueueTheBinary_ARealCompileJustWrote()
    {
        var mod = IndexedModFixture.Tracked();
        try
        {
            var pluginPath = Path.Combine(mod.ModFolder, IndexedModFixture.PluginName);
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(100));
            watcher.Watch(mod.ModFolder, IndexedModFixture.PluginName, pluginPath);

            var editService = ProjectingEditService.Over(mod.Index);
            editService.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);
            var compileService = CompileServices.Over(mod.Index);
            var result = compileService.Compile(mod.Plugin, new CompileSource.WorkingTree());
            Assert.True(result.Succeeded, result.RefusalReason);

            // Bounded, foreground wait past the quiet window — long enough that a real suppression
            // failure would show up as a queued item by the time this reads, short enough to stay a
            // fast test.
            Thread.Sleep(500);

            Assert.Empty(watcher.Unanswered());
        }
        finally
        {
            mod.Dispose();
        }
    }

    // ---- the indexed-binary route: retired from IndexedBinaryWatchTests ----

    private const string IndexedOrigin = "Data";
    private const string IndexedPlugin = "Mirrored.esp";

    private static string Sha256Of(byte[] bytes) => Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes));

    private sealed record IndexedFixture(string Folder, string PluginPath, string ContentHash);

    private static IndexedFixture NewIndexedBinary(byte[] bytes)
    {
        var folder = NewModFolder();
        var pluginPath = Path.Combine(folder, IndexedPlugin);
        File.WriteAllBytes(pluginPath, bytes);
        return new IndexedFixture(folder, pluginPath, Sha256Of(bytes));
    }

    private static (ModFolderWatcher Watcher, List<IndexedBinaryEvent> Events) WatchingIndexed(IndexedFixture fixture)
    {
        var events = new List<IndexedBinaryEvent>();
        var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(100));
        watcher.IndexedBinaryChanged = e => { lock (events) events.Add(e); return true; };
        watcher.WatchIndexed(IndexedPlugin, IndexedOrigin, fixture.PluginPath, fixture.ContentHash);
        return (watcher, events);
    }

    private static int Count(List<IndexedBinaryEvent> events)
    {
        lock (events) return events.Count;
    }

    // An untracked plugin — no mod folder in the Track sense, no question to ask the user — is
    // simply re-read.
    [Fact]
    public void AnIndexedBinaryWhoseBytesChange_IsReportedAsModified()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var (watcher, events) = WatchingIndexed(fixture);
            using var _ = watcher;

            File.WriteAllBytes(fixture.PluginPath, "changed-by-xedit"u8.ToArray());
            WaitUntil(() => Count(events) > 0, TimeSpan.FromSeconds(3));

            var change = Assert.Single(events);
            Assert.Equal(IndexedPlugin, change.PluginName);
            Assert.Equal(IndexedOrigin, change.Origin);
            Assert.Equal(fixture.PluginPath, change.PluginPath);
            Assert.Equal(IndexedBinaryChange.Modified, change.Change);
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
        }
    }

    // Content, never events: a rewrite landing the identical bytes — a touch, a mod manager
    // re-linking a file, a re-extract of the same archive — costs no re-index at all.
    [Fact]
    public void AnIndexedBinaryRewrittenWithIdenticalBytes_ReportsNothing()
    {
        var bytes = "original"u8.ToArray();
        var fixture = NewIndexedBinary(bytes);
        try
        {
            var (watcher, events) = WatchingIndexed(fixture);
            using var _ = watcher;

            File.WriteAllBytes(fixture.PluginPath, bytes);
            File.SetLastWriteTimeUtc(fixture.PluginPath, DateTime.UtcNow.AddSeconds(5));
            Thread.Sleep(500); // well past the 100ms quiet window

            Assert.Equal(0, Count(events));
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
        }
    }

    // A deletion is its own verb, never a modification: the index must forget the plugin, not
    // re-read a file that is not there.
    [Fact]
    public void AnIndexedBinaryThatIsDeleted_IsReportedAsDeleted_Once()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var (watcher, events) = WatchingIndexed(fixture);
            using var _ = watcher;

            File.Delete(fixture.PluginPath);
            WaitUntil(() => Count(events) > 0, TimeSpan.FromSeconds(3));
            Thread.Sleep(400); // let any follow-up events settle too

            var change = Assert.Single(events);
            Assert.Equal(IndexedBinaryChange.Deleted, change.Change);
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
        }
    }

    // A file that comes back after being deleted is a change again — the watch follows the disk in
    // both directions, which is what a mod reinstall or a Steam file verify actually looks like.
    [Fact]
    public void AnIndexedBinaryThatComesBack_IsReportedAsModified()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var (watcher, events) = WatchingIndexed(fixture);
            using var _ = watcher;

            File.Delete(fixture.PluginPath);
            WaitUntil(() => Count(events) > 0, TimeSpan.FromSeconds(3));

            File.WriteAllBytes(fixture.PluginPath, "reinstalled"u8.ToArray());
            WaitUntil(() => Count(events) > 1, TimeSpan.FromSeconds(3));

            lock (events)
            {
                Assert.Equal(2, events.Count);
                Assert.Equal(IndexedBinaryChange.Deleted, events[0].Change);
                Assert.Equal(IndexedBinaryChange.Modified, events[1].Change);
            }
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
        }
    }

    // The remembered hash goes back on failure, or the watcher believes the index matches bytes it
    // never read and the stale rows stand silently until the next load.
    [Fact]
    public void AChangeTheHandlerCouldNotApply_IsReportedAgainOnTheNextSettle()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var events = new List<IndexedBinaryEvent>();
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(100));
            watcher.IndexedBinaryChanged = e =>
            {
                lock (events) events.Add(e);
                return false; // the load order was torn down, the file was still held, …
            };
            watcher.WatchIndexed(IndexedPlugin, IndexedOrigin, fixture.PluginPath, fixture.ContentHash);

            File.WriteAllBytes(fixture.PluginPath, "changed-by-xedit"u8.ToArray());
            WaitUntil(() => Count(events) > 0, TimeSpan.FromSeconds(3));

            // The *same* bytes settle again. Had the failed report advanced the remembered hash,
            // this would raise nothing at all and the index would stay stale.
            File.SetLastWriteTimeUtc(fixture.PluginPath, DateTime.UtcNow.AddSeconds(5));
            File.AppendAllText(fixture.PluginPath, "");
            WaitUntil(() => Count(events) > 1, TimeSpan.FromSeconds(3));

            lock (events)
            {
                Assert.True(events.Count >= 2, $"expected the change to be reported again, saw {events.Count}");
                Assert.All(events, e => Assert.Equal(IndexedBinaryChange.Modified, e.Change));
            }
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
        }
    }

    // A watch must not outlive the load order that asked for it, or a plugin the load order has
    // dropped would keep re-indexing itself into it.
    [Fact]
    public void UnwatchAllIndexed_StopsTheWatch()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var (watcher, events) = WatchingIndexed(fixture);
            using var _ = watcher;
            watcher.UnwatchAllIndexed();

            File.WriteAllBytes(fixture.PluginPath, "changed-after-unwatch"u8.ToArray());
            Thread.Sleep(500);

            Assert.Equal(0, Count(events));
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
        }
    }

    // ---- per-mod batching: retired from SourceChangeWatcherTests. ADR-0046: each mod folder
    // settles on its own quiet and bounding timers, so a batch is per mod. ----

    private static string NewSourceRoot(string modFolder, string pluginName)
    {
        var sourceRoot = Path.Combine(modFolder, "source", pluginName);
        Directory.CreateDirectory(sourceRoot);
        return sourceRoot;
    }

    private static void Write(string sourceRoot) =>
        File.WriteAllText(Path.Combine(sourceRoot, "record.json"), Guid.NewGuid().ToString());

    [Fact]
    public void WritesToTwoPluginsOfOneMod_WithinTheQuietWindow_SettleAsOneBatchNamingBoth()
    {
        var modFolder = NewModFolder();
        try
        {
            var sourceA = NewSourceRoot(modFolder, "A.esp");
            var sourceB = NewSourceRoot(modFolder, "B.esp");
            var batches = new List<IReadOnlyList<SourceChangeEvent>>();
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(200), TimeSpan.FromSeconds(5));
            watcher.SourceChanged = batch => { lock (batches) batches.Add(batch); };
            watcher.Watch(modFolder, sourceA, "A.esp", "OneMod");
            watcher.Watch(modFolder, sourceB, "B.esp", "OneMod");

            Write(sourceA);
            Thread.Sleep(50); // well inside the 200ms quiet window
            Write(sourceB);

            WaitUntil(() => batches.Count > 0, TimeSpan.FromSeconds(5));
            // Long enough that a wrongly-split second batch would have landed too.
            Thread.Sleep(400);

            List<IReadOnlyList<SourceChangeEvent>> snapshot;
            lock (batches) snapshot = [.. batches];
            var batch = Assert.Single(snapshot);
            Assert.Equal(2, batch.Count);
            Assert.Contains(batch, e => e.PluginName == "A.esp");
            Assert.Contains(batch, e => e.PluginName == "B.esp");
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // The rival this pins: a watcher-wide timer (the pre-ticket design) would coalesce these two
    // mods' writes into one batch too, since both land inside 200ms of each other.
    [Fact]
    public void WritesToTwoDifferentMods_WithinTheOthersQuietWindow_SettleAsTwoSeparateBatches()
    {
        var modA = NewModFolder();
        var modB = NewModFolder();
        try
        {
            var sourceA = NewSourceRoot(modA, "A.esp");
            var sourceB = NewSourceRoot(modB, "B.esp");
            var batches = new List<IReadOnlyList<SourceChangeEvent>>();
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(200), TimeSpan.FromSeconds(5));
            watcher.SourceChanged = batch => { lock (batches) batches.Add(batch); };
            watcher.Watch(modA, sourceA, "A.esp", "ModA");
            watcher.Watch(modB, sourceB, "B.esp", "ModB");

            Write(sourceA);
            Thread.Sleep(50); // well inside the 200ms quiet window, but a different mod's own timer
            Write(sourceB);

            WaitUntil(() => batches.Count >= 2, TimeSpan.FromSeconds(5));

            List<IReadOnlyList<SourceChangeEvent>> snapshot;
            lock (batches) snapshot = [.. batches];
            Assert.Equal(2, snapshot.Count);
            Assert.Equal("A.esp", Assert.Single(snapshot[0]).PluginName);
            Assert.Equal("B.esp", Assert.Single(snapshot[1]).PluginName);
        }
        finally
        {
            Directory.Delete(modA, recursive: true);
            Directory.Delete(modB, recursive: true);
        }
    }

    [Fact]
    public void AStreamThatNeverGoesQuiet_StillSettlesAtTheMaximumWindow()
    {
        var modFolder = NewModFolder();
        try
        {
            var sourceA = NewSourceRoot(modFolder, "A.esp");
            var landedAt = new List<TimeSpan>();
            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            // Quiet is far longer than both the write cadence and the maximum window, so only the
            // maximum window can force a settle before the stream stops.
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(1500), TimeSpan.FromMilliseconds(300));
            watcher.SourceChanged = _ => { lock (landedAt) landedAt.Add(stopwatch.Elapsed); };
            watcher.Watch(modFolder, sourceA, "A.esp", "OneMod");

            var deadline = DateTime.UtcNow + TimeSpan.FromMilliseconds(900);
            while (DateTime.UtcNow < deadline)
            {
                Write(sourceA);
                Thread.Sleep(50);
            }

            WaitUntil(() => landedAt.Count > 0, TimeSpan.FromSeconds(5));
            List<TimeSpan> snapshot;
            lock (landedAt) snapshot = [.. landedAt];
            Assert.NotEmpty(snapshot);
            Assert.True(snapshot[0] < TimeSpan.FromMilliseconds(700), $"first batch landed at {snapshot[0]}");
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // ---- routing: the repository says what to watch, this type holds no layout literal ----

    [Fact]
    public void ARefMove_RefreshesEveryPluginOfTheModWhole()
    {
        var modFolder = NewModFolder();
        try
        {
            var sourceA = NewSourceRoot(modFolder, "A.esp");
            var sourceB = NewSourceRoot(modFolder, "B.esp");
            Directory.CreateDirectory(Path.Combine(modFolder, ".git"));
            var batches = new List<IReadOnlyList<SourceChangeEvent>>();
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(5));
            watcher.SourceChanged = batch => { lock (batches) batches.Add(batch); };
            watcher.Watch(modFolder, sourceA, "A.esp", "OneMod");
            watcher.Watch(modFolder, sourceB, "B.esp", "OneMod");

            File.WriteAllText(Path.Combine(modFolder, ".git", "HEAD"), "ref: refs/heads/main\n");

            WaitUntil(() => batches.Count > 0, TimeSpan.FromSeconds(3));

            var batch = Assert.Single(batches);
            Assert.Equal(2, batch.Count);
            Assert.All(batch, e => Assert.Equal(SourceChangeScope.WholePlugin, e.Scope));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void AnUnrelatedFileUnderTheModFolder_RaisesNoBatchAndNoExternalChange()
    {
        var modFolder = NewModFolder();
        try
        {
            var sourceA = NewSourceRoot(modFolder, "A.esp");
            var batches = new List<IReadOnlyList<SourceChangeEvent>>();
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(5));
            watcher.SourceChanged = batch => { lock (batches) batches.Add(batch); };
            watcher.Watch(modFolder, sourceA, "A.esp", "OneMod");

            // Neither the source root, git, nor a load-order plugin file: an untracked loose asset.
            File.WriteAllText(Path.Combine(modFolder, "readme.txt"), "not a plugin, not source, not git");
            Thread.Sleep(400);

            Assert.Empty(batches);
            Assert.Empty(watcher.Unanswered());
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // ---- recursion cost: an indexed-only folder (the game's Data/) never gets a subtree watch ----

    [Fact]
    public void WatchIndexed_DoesNotWatchSubdirectories()
    {
        var folder = NewModFolder();
        try
        {
            var pluginPath = Path.Combine(folder, IndexedPlugin);
            var original = "original"u8.ToArray();
            File.WriteAllBytes(pluginPath, original);
            var events = new List<IndexedBinaryEvent>();
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(100));
            watcher.IndexedBinaryChanged = e => { lock (events) events.Add(e); return true; };
            watcher.WatchIndexed(IndexedPlugin, IndexedOrigin, pluginPath, Sha256Of(original));

            Directory.CreateDirectory(Path.Combine(folder, "Textures"));
            File.WriteAllText(Path.Combine(folder, "Textures", "unrelated.txt"), "loose asset");
            Thread.Sleep(400);
            Assert.Equal(0, Count(events));

            // The watch is alive all the same: the top-level plugin binary still settles.
            File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());
            WaitUntil(() => Count(events) > 0, TimeSpan.FromSeconds(3));
            Assert.Single(events);
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    // The rival this pins: an upgrade that never happens leaves Track's own hand edits unseen.
    [Fact]
    public void Watch_UpgradesAnIndexedOnlyFolder_ToWatchItsSubdirectoriesToo()
    {
        var folder = NewModFolder();
        try
        {
            var indexedPath = Path.Combine(folder, IndexedPlugin);
            File.WriteAllBytes(indexedPath, "original"u8.ToArray());
            using var watcher = new ModFolderWatcher(TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(5));
            watcher.WatchIndexed(IndexedPlugin, IndexedOrigin, indexedPath, Sha256Of("original"u8.ToArray()));

            var batches = new List<IReadOnlyList<SourceChangeEvent>>();
            watcher.SourceChanged = batch => { lock (batches) batches.Add(batch); };
            var sourceRoot = NewSourceRoot(folder, "Tracked.esp");
            watcher.Watch(folder, sourceRoot, "Tracked.esp", "TrackedOrigin");

            Write(sourceRoot);
            WaitUntil(() => batches.Count > 0, TimeSpan.FromSeconds(3));

            var batch = Assert.Single(batches);
            Assert.Equal("Tracked.esp", Assert.Single(batch).PluginName);
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }
}
