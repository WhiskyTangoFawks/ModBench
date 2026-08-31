using System.Security.Cryptography;
using MEditService.Bridge;

namespace MEditService.Tests.Bridge;

/// <summary>
/// ADR-0001: the runtime mirror. The external-change watcher covers every <i>indexed</i>
/// binary, the game's own <c>Data/</c> included — not just the tracked ones — and says what actually
/// happened to it so the index can follow. Real filesystem, real debounce timing, no mocked
/// <see cref="FileSystemWatcher"/>, matching this file's sibling suite.
/// </summary>
public sealed class IndexedBinaryWatchTests
{
    private const string Origin = "Data";
    private const string Plugin = "Mirrored.esp";

    private static string Sha256Of(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static void WaitUntil(Func<bool> condition, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return;
            Thread.Sleep(20);
        }
    }

    private sealed record Fixture(string Folder, string PluginPath, string ContentHash);

    private static Fixture NewIndexedBinary(byte[] bytes)
    {
        var folder = Directory.CreateTempSubdirectory("medit-mirror-").FullName;
        var pluginPath = Path.Combine(folder, Plugin);
        File.WriteAllBytes(pluginPath, bytes);
        return new Fixture(folder, pluginPath, Sha256Of(bytes));
    }

    private static (ExternalChangeWatcher Watcher, List<IndexedBinaryEvent> Events) Watching(Fixture fixture)
    {
        var events = new List<IndexedBinaryEvent>();
        var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
        watcher.IndexedBinaryChanged = e => { lock (events) events.Add(e); return true; };
        watcher.WatchIndexed(Plugin, Origin, fixture.PluginPath, fixture.ContentHash);
        return (watcher, events);
    }

    private static int Count(List<IndexedBinaryEvent> events)
    {
        lock (events) return events.Count;
    }

    // An untracked plugin — no mod folder, no source tree, no question to ask the user — is
    // simply re-read.
    [Fact]
    public void AnIndexedBinaryWhoseBytesChange_IsReportedAsModified()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var (watcher, events) = Watching(fixture);
            using var _ = watcher;

            File.WriteAllBytes(fixture.PluginPath, "changed-by-xedit"u8.ToArray());
            WaitUntil(() => Count(events) > 0, TimeSpan.FromSeconds(3));

            var change = Assert.Single(events);
            Assert.Equal(Plugin, change.PluginName);
            Assert.Equal(Origin, change.Origin);
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
            var (watcher, events) = Watching(fixture);
            using var _ = watcher;

            File.WriteAllBytes(fixture.PluginPath, bytes);
            File.SetLastWriteTimeUtc(fixture.PluginPath, DateTime.UtcNow.AddSeconds(5));
            Thread.Sleep(500); // well past the 100ms debounce window

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
            var (watcher, events) = Watching(fixture);
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

    // A file that comes back after being deleted is a change again — the mirror follows the disk in
    // both directions, which is what a mod reinstall or a Steam file verify actually looks like.
    [Fact]
    public void AnIndexedBinaryThatComesBack_IsReportedAsModified()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var (watcher, events) = Watching(fixture);
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

    // A change the handler could not apply must not leave the watcher believing the index matches
    // bytes it never read: the remembered hash goes back, and the next settle reports it again. An
    // unretried failure would be stale rows nothing on disk backs, silently, until the next load.
    [Fact]
    public void AChangeTheHandlerCouldNotApply_IsReportedAgainOnTheNextSettle()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var events = new List<IndexedBinaryEvent>();
            using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
            watcher.IndexedBinaryChanged = e =>
            {
                lock (events) events.Add(e);
                return false; // the load order was torn down, the file was still held, …
            };
            watcher.WatchIndexed(Plugin, Origin, fixture.PluginPath, fixture.ContentHash);

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

    // A watch must not outlive the load order that asked for it, or a plugin the load order no longer
    // holds would keep re-indexing itself into it.
    [Fact]
    public void UnwatchAllIndexed_StopsTheMirror()
    {
        var fixture = NewIndexedBinary("original"u8.ToArray());
        try
        {
            var (watcher, events) = Watching(fixture);
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
}
