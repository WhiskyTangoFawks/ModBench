using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Http;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using MEditService.Watcher;
using Mutagen.Bethesda;

namespace MEditService.Tests.Bridge;

/// <summary>ADR-0014: one recursive watcher per mod folder, tracked or not — the indexed-binary
/// route and per-mod batching, each asserted by what the watcher then asked of the Index.</summary>
public sealed class ModFolderWatcherTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-modwatch-").FullName;

    // A repository with a source root per plugin, each parked at its real hash if a binary exists
    // on disk, so Commands' own classify finds self-echo rather than a spurious external change.
    private static void TrackTree(string modFolder, params string[] plugins)
    {
        var files = plugins
            .Select(p => new TreeFile($"source/{p}/npc_/{p}/000001.json", "{}"u8.ToArray()))
            .ToArray();
        var trailers = new TrackProvenance(
            null, null, plugins.ToDictionary(p => p, p => RealOrPlaceholderHash(modFolder, p), StringComparer.Ordinal));
        SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);
    }

    private static string RealOrPlaceholderHash(string modFolder, string plugin)
    {
        var path = Path.Combine(modFolder, plugin);
        return File.Exists(path) ? PluginBinaryHash.TrailerFormOfFile(path) : "unused-at-track-time";
    }

    private static ModFolderWatcher Projecting(
        RecordingRefreshIndex index, TimeSpan quiet, TimeSpan? maxWindow = null) =>
        TestWatcher.Over(
            new LoadOrderHolder(), index, new InMemoryNotificationPublisher(), quiet, maxWindow);

    private static void WaitUntil(Func<bool> condition, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return;
            Thread.Sleep(20);
        }
    }

    // ---- the indexed-binary route: retired from IndexedBinaryWatchTests ----

    private const string IndexedOrigin = "Data";
    private const string IndexedPlugin = "Mirrored.esp";
    private static readonly PluginCopyKey IndexedCopy = new(IndexedPlugin, IndexedOrigin);

    private static string Sha256Of(byte[] bytes) => Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes));

    private sealed record IndexedFixture(string Folder, string PluginPath, string ContentHash);

    private static IndexedFixture NewIndexedBinary(byte[] bytes)
    {
        var folder = NewModFolder();
        var pluginPath = Path.Combine(folder, IndexedPlugin);
        File.WriteAllBytes(pluginPath, bytes);
        return new IndexedFixture(folder, pluginPath, Sha256Of(bytes));
    }

    // Seeded as already indexed with the bytes on disk now — the state a prior reconcile would
    // have left, since the comparison this route settles against is the Index's own.
    private static (ModFolderWatcher Watcher, RecordingRefreshIndex Index) WatchingIndexed(IndexedFixture fixture)
    {
        var index = new RecordingRefreshIndex();
        index.SeedIndexed(IndexedCopy, fixture.ContentHash);
        var watcher = Projecting(index, TimeSpan.FromMilliseconds(100));
        watcher.WatchIndexed(IndexedPlugin, IndexedOrigin, fixture.PluginPath);
        return (watcher, index);
    }

    // An untracked plugin — no mod folder in the Track sense, no question to ask the user — is
    // simply re-read.
    [Fact]
    public void AnIndexedBinaryWhoseBytesChange_IsReindexed()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var (watcher, index) = WatchingIndexed(fixture);
            using var _ = watcher;

            File.WriteAllBytes(fixture.PluginPath, "changed-by-xedit"u8.ToArray());
            WaitUntil(() => index.Projections.Count > 0, TimeSpan.FromSeconds(3));

            Assert.Equal(IndexedCopy, Assert.Single(index.Of("reindex")).Plugin);
            Assert.Empty(index.Of("unindex"));
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
        }
    }

    // Content, never events: a rewrite landing the identical bytes — a touch, a mod manager
    // re-linking a file, a re-extract of the same archive — costs no re-index at all.
    [Fact]
    public void AnIndexedBinaryRewrittenWithIdenticalBytes_ReachesTheIndexNotAtAll()
    {
        var bytes = "original"u8.ToArray();
        var fixture = NewIndexedBinary(bytes);
        try
        {
            var (watcher, index) = WatchingIndexed(fixture);
            using var _ = watcher;

            File.WriteAllBytes(fixture.PluginPath, bytes);
            File.SetLastWriteTimeUtc(fixture.PluginPath, DateTime.UtcNow.AddSeconds(5));
            Thread.Sleep(500); // well past the 100ms quiet window

            Assert.Empty(index.Projections);
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
        }
    }

    // A deletion is its own verb, never a modification: the index must forget the plugin, not
    // re-read a file that is not there.
    [Fact]
    public void AnIndexedBinaryThatIsDeleted_IsUnindexed_Once()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var (watcher, index) = WatchingIndexed(fixture);
            using var _ = watcher;

            File.Delete(fixture.PluginPath);
            WaitUntil(() => index.Projections.Count > 0, TimeSpan.FromSeconds(3));
            Thread.Sleep(400); // let any follow-up events settle too

            Assert.Equal(IndexedCopy, Assert.Single(index.Of("unindex")).Plugin);
            Assert.Empty(index.Of("reindex"));
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
        }
    }

    // A file that comes back after being deleted is a change again — the watch follows the disk in
    // both directions, which is what a mod reinstall or a Steam file verify actually looks like.
    [Fact]
    public void AnIndexedBinaryThatComesBack_IsReindexed()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var (watcher, index) = WatchingIndexed(fixture);
            using var _ = watcher;

            File.Delete(fixture.PluginPath);
            WaitUntil(() => index.Projections.Count > 0, TimeSpan.FromSeconds(3));

            File.WriteAllBytes(fixture.PluginPath, "reinstalled"u8.ToArray());
            WaitUntil(() => index.Projections.Count > 1, TimeSpan.FromSeconds(3));

            Assert.Equal(["unindex", "reindex"], index.Projections.Select(p => p.Verb));
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
        }
    }

    // The remembered hash goes back on failure, or the watcher believes the index matches bytes it
    // never read and the stale rows stand silently until the next load.
    [Fact]
    public void AChangeTheIndexCouldNotTake_IsProjectedAgainOnTheNextSettle()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            // The load order was torn down, the file was still held, …
            var index = new RecordingRefreshIndex { Refuses = true };
            index.SeedIndexed(IndexedCopy, fixture.ContentHash);
            using var watcher = Projecting(index, TimeSpan.FromMilliseconds(100));
            watcher.WatchIndexed(IndexedPlugin, IndexedOrigin, fixture.PluginPath);

            File.WriteAllBytes(fixture.PluginPath, "changed-by-xedit"u8.ToArray());
            WaitUntil(() => index.Of("reindex").Count > 0, TimeSpan.FromSeconds(3));

            // The *same* bytes settle again. Had the refused projection advanced the remembered
            // hash, this would raise nothing at all and the index would stay stale.
            File.SetLastWriteTimeUtc(fixture.PluginPath, DateTime.UtcNow.AddSeconds(5));
            File.AppendAllText(fixture.PluginPath, "");
            WaitUntil(() => index.Of("reindex").Count > 1, TimeSpan.FromSeconds(3));

            var reindexed = index.Of("reindex");
            Assert.True(reindexed.Count >= 2, $"expected the change to be projected again, saw {reindexed.Count}");
            Assert.All(reindexed, r => Assert.Equal(IndexedCopy, r.Plugin));
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
            var (watcher, index) = WatchingIndexed(fixture);
            using var _ = watcher;
            watcher.UnwatchAllIndexed();

            File.WriteAllBytes(fixture.PluginPath, "changed-after-unwatch"u8.ToArray());
            Thread.Sleep(500);

            Assert.Empty(index.Projections);
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
        }
    }

    // ADR-0003 (Option 2 ruling): WatchIndexed arms every non-tracked copy unconditionally — a copy
    // the Index has never indexed still reaches it once its bytes change, with no reconcile between.
    [Fact]
    public void ACopyTheIndexHasNeverIndexed_IsStillArmed_AndReachesTheIndexWhenItChanges()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var index = new RecordingRefreshIndex(); // never seeded: nothing indexed for this copy yet.
            using var watcher = Projecting(index, TimeSpan.FromMilliseconds(100));
            watcher.WatchIndexed(IndexedPlugin, IndexedOrigin, fixture.PluginPath);

            File.WriteAllBytes(fixture.PluginPath, "changed-by-xedit"u8.ToArray());
            WaitUntil(() => index.Projections.Count > 0, TimeSpan.FromSeconds(3));

            Assert.Equal(IndexedCopy, Assert.Single(index.Of("reindex")).Plugin);
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
        }
    }

    // The rival this pins: a SubscribeTo that never wires the Changed event, so a load order arriving
    // through holder.Apply would leave every plugin unwatched.
    [Fact]
    public void SubscribeTo_ArmsTheWatchWhenTheLoadOrderChanges()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        var gameDirectory = Directory.CreateTempSubdirectory("medit-modwatch-game-").FullName;
        try
        {
            var index = new RecordingRefreshIndex();
            var holder = new LoadOrderHolder();
            using var watcher = TestWatcher.Over(
                holder, index, new InMemoryNotificationPublisher(), TimeSpan.FromMilliseconds(100));
            watcher.SubscribeTo(holder);

            var entry = new LoadOrderEntry(IndexedPlugin, fixture.PluginPath, IndexedOrigin, 0, Enabled: true, Winning: true);
            holder.Apply(ForcedPlugins.Snapshot(gameDirectory, null, GameRelease.Fallout4, [entry]));

            // The re-arm runs off the caller's thread, so the watch may not be live the instant
            // Apply returns — retried until it is, rather than raced with a fixed sleep.
            WaitUntil(() =>
            {
                if (index.Projections.Count == 0) File.WriteAllBytes(fixture.PluginPath, Guid.NewGuid().ToByteArray());
                return index.Projections.Count > 0;
            }, TimeSpan.FromSeconds(5));

            Assert.Equal(IndexedCopy, Assert.Single(index.Of("reindex")).Plugin);
        }
        finally
        {
            Directory.Delete(fixture.Folder, recursive: true);
            Directory.Delete(gameDirectory, recursive: true);
        }
    }

    // ---- per-mod batching: retired from SourceChangeWatcherTests. ADR-0014: each mod folder
    // settles on its own quiet and bounding timers, so a batch is per mod. ----

    private static void Write(string sourceRoot) =>
        File.WriteAllText(Path.Combine(sourceRoot, "record.json"), Guid.NewGuid().ToString());

    private static IReadOnlyList<string> ValidatedIn(RecordingRefreshIndex index, int scope) =>
        [.. index.Of("validate").Where(p => p.Scope == scope)
            .Select(p => (p.Plugin ?? throw new InvalidOperationException("Expected a validate record to carry its Plugin.")).Name)
            .Order(StringComparer.Ordinal)];

    private static int Scopes(RecordingRefreshIndex index) => index.Of("projection").Count;

    [Fact]
    public void WritesToTwoPluginsOfOneMod_WithinTheQuietWindow_SettleAsOneBatchNamingBoth()
    {
        var modFolder = NewModFolder();
        try
        {
            TrackTree(modFolder, "A.esp", "B.esp");
            var sourceA = SourceRepository.RootIn(modFolder, "A.esp");
            var sourceB = SourceRepository.RootIn(modFolder, "B.esp");
            var index = new RecordingRefreshIndex();
            using var watcher = Projecting(index, TimeSpan.FromMilliseconds(200), TimeSpan.FromSeconds(5));
            watcher.Watch(modFolder, sourceA, "A.esp", "OneMod");
            watcher.Watch(modFolder, sourceB, "B.esp", "OneMod");

            Write(sourceA);
            Thread.Sleep(50); // well inside the 200ms quiet window
            Write(sourceB);

            WaitUntil(() => index.Of("validate").Count >= 2, TimeSpan.FromSeconds(5));
            // Long enough that a wrongly-split second batch would have landed too.
            Thread.Sleep(400);

            Assert.Equal(1, Scopes(index));
            Assert.Equal(["A.esp", "B.esp"], ValidatedIn(index, 1));
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
            TrackTree(modA, "A.esp");
            TrackTree(modB, "B.esp");
            var sourceA = SourceRepository.RootIn(modA, "A.esp");
            var sourceB = SourceRepository.RootIn(modB, "B.esp");
            var index = new RecordingRefreshIndex();
            using var watcher = Projecting(index, TimeSpan.FromMilliseconds(200), TimeSpan.FromSeconds(5));
            watcher.Watch(modA, sourceA, "A.esp", "ModA");
            watcher.Watch(modB, sourceB, "B.esp", "ModB");

            Write(sourceA);
            Thread.Sleep(50); // well inside the 200ms quiet window, but a different mod's own timer
            Write(sourceB);

            WaitUntil(() => index.Of("validate").Count >= 2, TimeSpan.FromSeconds(5));

            Assert.Equal(2, Scopes(index));
            Assert.Equal(["A.esp"], ValidatedIn(index, 1));
            Assert.Equal(["B.esp"], ValidatedIn(index, 2));
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
            TrackTree(modFolder, "A.esp");
            var sourceA = SourceRepository.RootIn(modFolder, "A.esp");
            var index = new RecordingRefreshIndex();
            // Quiet is far longer than both the write cadence and the maximum window, so only the
            // maximum window can force a settle before the stream stops.
            using var watcher = Projecting(
                index, TimeSpan.FromMilliseconds(1500), TimeSpan.FromMilliseconds(300));
            watcher.Watch(modFolder, sourceA, "A.esp", "OneMod");

            var deadline = DateTime.UtcNow + TimeSpan.FromMilliseconds(900);
            while (DateTime.UtcNow < deadline)
            {
                Write(sourceA);
                Thread.Sleep(50);
            }

            WaitUntil(() => Scopes(index) > 0, TimeSpan.FromSeconds(5));
            var first = index.Of("projection")[0];
            Assert.True(first.At < TimeSpan.FromMilliseconds(700), $"first batch landed at {first.At}");
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // ---- routing: the repository says what to watch, this type holds no layout literal ----

    // The narrow route. A whole-copy validate lands the same rows in the end, so only the verb the
    // Index was asked for tells the two apart.
    [Fact]
    public void ADocumentThatNamesItsRecord_IsRefreshedByKey_NotValidatedWhole()
    {
        var modFolder = NewModFolder();
        try
        {
            TrackTree(modFolder, "A.esp");
            var sourceA = SourceRepository.RootIn(modFolder, "A.esp");
            var index = new RecordingRefreshIndex();
            using var watcher = Projecting(index, TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(5));
            watcher.Watch(modFolder, sourceA, "A.esp", "OneMod");

            File.WriteAllText(
                Path.Combine(sourceA, "Named - 000800.json"), """{"FormKey":"000800:A.esp"}""");

            WaitUntil(() => index.Of("refresh").Count > 0, TimeSpan.FromSeconds(3));

            var refreshed = Assert.Single(index.Of("refresh"));
            var refreshedPlugin = refreshed.Plugin
                ?? throw new InvalidOperationException("Expected the refresh record to carry its Plugin.");
            Assert.Equal("A.esp", refreshedPlugin.Name);
            Assert.Equal(["000800:A.esp"], refreshed.Keys);
            Assert.Empty(index.Of("validate"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void ARefMove_RefreshesEveryPluginOfTheModWhole()
    {
        var modFolder = NewModFolder();
        try
        {
            TrackTree(modFolder, "A.esp", "B.esp");
            var index = new RecordingRefreshIndex();
            using var watcher = Projecting(index, TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(5));
            watcher.Watch(modFolder, SourceRepository.RootIn(modFolder, "A.esp"), "A.esp", "OneMod");
            watcher.Watch(modFolder, SourceRepository.RootIn(modFolder, "B.esp"), "B.esp", "OneMod");

            File.WriteAllText(Path.Combine(modFolder, ".git", "HEAD"), "ref: refs/heads/main\n");

            WaitUntil(() => index.Of("validate").Count >= 2, TimeSpan.FromSeconds(3));

            Assert.Equal(1, Scopes(index));
            Assert.Equal(["A.esp", "B.esp"], ValidatedIn(index, 1));
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
            var sourceA = Path.Combine(modFolder, "source", "A.esp");
            Directory.CreateDirectory(sourceA);
            var index = new RecordingRefreshIndex();
            using var watcher = Projecting(index, TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(5));
            watcher.Watch(modFolder, sourceA, "A.esp", "OneMod");

            // Neither the source root, git, nor a load-order plugin file: an untracked loose asset.
            File.WriteAllText(Path.Combine(modFolder, "readme.txt"), "not a plugin, not source, not git");
            Thread.Sleep(400);

            Assert.Empty(index.Projections);
            Assert.Null(SourceRepository.UnansweredExternalChange(modFolder));
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
            var index = new RecordingRefreshIndex();
            index.SeedIndexed(IndexedCopy, Sha256Of(original));
            using var watcher = Projecting(index, TimeSpan.FromMilliseconds(100));
            watcher.WatchIndexed(IndexedPlugin, IndexedOrigin, pluginPath);

            Directory.CreateDirectory(Path.Combine(folder, "Textures"));
            File.WriteAllText(Path.Combine(folder, "Textures", "unrelated.txt"), "loose asset");
            Thread.Sleep(400);
            Assert.Empty(index.Projections);

            // The watch is alive all the same: the top-level plugin binary still settles.
            File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());
            WaitUntil(() => index.Of("reindex").Count > 0, TimeSpan.FromSeconds(3));
            Assert.Single(index.Of("reindex"));
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
            TrackTree(folder, "Tracked.esp");
            var indexedPath = Path.Combine(folder, IndexedPlugin);
            File.WriteAllBytes(indexedPath, "original"u8.ToArray());
            var index = new RecordingRefreshIndex();
            index.SeedIndexed(IndexedCopy, Sha256Of("original"u8.ToArray()));
            using var watcher = Projecting(index, TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(5));
            watcher.WatchIndexed(IndexedPlugin, IndexedOrigin, indexedPath);

            var sourceRoot = SourceRepository.RootIn(folder, "Tracked.esp");
            watcher.Watch(folder, sourceRoot, "Tracked.esp", "TrackedOrigin");

            Write(sourceRoot);
            WaitUntil(() => index.Of("validate").Count > 0, TimeSpan.FromSeconds(3));

            Assert.Equal(["Tracked.esp"], ValidatedIn(index, 1));
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    // ---- Track: the mod is watched before it holds a repository ----

    // The rival this pins: a registration made after Track's commit has no ref move left to see, so
    // the tree Track just wrote never reaches the Index.
    [Fact]
    public void TrackingAModTheLoadOrderHolds_ValidatesItWholeOnce_WithNoReconcile()
    {
        var modFolder = NewModFolder();
        try
        {
            var holder = HoldingUntracked(modFolder, "Tracked.esp", "TrackedMod");
            var index = new RecordingRefreshIndex();
            using var watcher = TestWatcher.Over(
                holder, index, new InMemoryNotificationPublisher(), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(30));
            watcher.Rearm(holder.Current);

            watcher.WatchSourceOf("TrackedMod");
            TrackTree(modFolder, "Tracked.esp");

            WaitUntil(() => index.Of("validate").Count > 0, TimeSpan.FromSeconds(10));
            // Past a further quiet window, so a second batch would have landed its own scope by now.
            Thread.Sleep(1500);
            Assert.Equal(1, Scopes(index));
            Assert.Equal(["Tracked.esp"], ValidatedIn(index, 1));
            Assert.Empty(index.Of("refresh"));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // The rival this pins: unregistering the source root on a settle that finds no repository, which
    // takes Track's registration with it while Track is still parsing.
    [Fact]
    public void ASettleBeforeTheRepositoryExists_KeepsTheRegistration_SoTracksOwnTreeStillLands()
    {
        var modFolder = NewModFolder();
        try
        {
            var holder = HoldingUntracked(modFolder, "Tracked.esp", "TrackedMod");
            var index = new RecordingRefreshIndex();
            using var watcher = TestWatcher.Over(
                holder, index, new InMemoryNotificationPublisher(), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(30));
            watcher.Rearm(holder.Current);
            watcher.WatchSourceOf("TrackedMod");

            var sourceRoot = SourceRepository.RootIn(modFolder, "Tracked.esp");
            Directory.CreateDirectory(sourceRoot);
            Write(sourceRoot);
            WaitUntil(() => Scopes(index) > 0, TimeSpan.FromSeconds(10));
            Assert.Empty(index.Of("validate"));

            TrackTree(modFolder, "Tracked.esp");

            WaitUntil(() => index.Of("validate").Count > 0, TimeSpan.FromSeconds(10));
            Assert.Equal(["Tracked.esp"], ValidatedIn(index, 2));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // A mod folder the gesture registering it is about to create has nothing to watch yet, so that
    // tree's own burst is lost; the rival this pins is registering once and never again.
    [Fact]
    public void RegisteringAModFolderNotOnDiskYet_ArmsNothing_UntilItIsRegisteredAgain()
    {
        var modFolder = Path.Combine(Path.GetTempPath(), $"medit-modwatch-{Guid.NewGuid():N}");
        try
        {
            var holder = new LoadOrderHolder();
            holder.Apply(new LoadOrderSnapshot(modFolder, modFolder, GameRelease.Fallout4,
                [new RegisteredCopy("Tracked.esp", "TrackedMod", Path.Combine(modFolder, "Tracked.esp"),
                    Slot: 0, Enabled: true, Winning: true)]));
            var index = new RecordingRefreshIndex();
            using var watcher = TestWatcher.Over(
                holder, index, new InMemoryNotificationPublisher(), TimeSpan.FromMilliseconds(200), TimeSpan.FromSeconds(30));
            watcher.WatchSourceOf("TrackedMod");

            Directory.CreateDirectory(modFolder);
            TrackTree(modFolder, "Tracked.esp");
            Thread.Sleep(600);
            Assert.Empty(index.Projections);

            watcher.WatchSourceOf("TrackedMod");
            Write(SourceRepository.RootIn(modFolder, "Tracked.esp"));

            WaitUntil(() => index.Of("validate").Count > 0, TimeSpan.FromSeconds(5));
            Assert.Equal(["Tracked.esp"], ValidatedIn(index, 1));
        }
        finally
        {
            if (Directory.Exists(modFolder)) Directory.Delete(modFolder, recursive: true);
        }
    }

    private static LoadOrderHolder HoldingUntracked(string modFolder, string plugin, string origin)
    {
        var pluginPath = Path.Combine(modFolder, plugin);
        File.WriteAllBytes(pluginPath, "a binary no source tree covers yet"u8.ToArray());
        var holder = new LoadOrderHolder();
        holder.Apply(new LoadOrderSnapshot(modFolder, modFolder, GameRelease.Fallout4,
            [new RegisteredCopy(plugin, origin, pluginPath, Slot: 0, Enabled: true, Winning: true)]));
        return holder;
    }
}
