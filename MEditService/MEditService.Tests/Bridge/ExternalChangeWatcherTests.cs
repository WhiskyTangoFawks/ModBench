using MEditService.Bridge;
using MEditService.Core.Ledger;

namespace MEditService.Tests.Bridge;

/// <summary>
/// #417 B10: <see cref="ExternalChangeWatcher"/> — the live-watch half. Real filesystem, real
/// debounce timing, no mocked <c>FileSystemWatcher</c>.
/// </summary>
public sealed class ExternalChangeWatcherTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-watch-").FullName;

    private static string Track(string modFolder, string plugin, byte[] parkedBinary)
    {
        var files = new[] { new PristineFile($"{plugin}.ledger/npc_/{plugin}/000001.json", "{}"u8.ToArray()) };
        var trailers = new TrackProvenance(null, null, new Dictionary<string, string> { [plugin] = "unused-at-track-time" });
        LedgerRepository.Track(modFolder, LedgerPreset.Edits, files, trailers);

        var pluginPath = Path.Combine(modFolder, plugin);
        File.WriteAllBytes(pluginPath, parkedBinary);
        var binarySha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(parkedBinary));
        LedgerRepository.ParkCompileSnapshot(modFolder, plugin, atRef: null, binarySha256);
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

    [Fact]
    public void Watch_QueuesAPendingExternalChange_WhenTheWatchedBinaryChanges()
    {
        var modFolder = NewModFolder();
        try
        {
            var pluginPath = Track(modFolder, "Test.esp", "original"u8.ToArray());
            using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
            watcher.Watch(modFolder, "Test.esp", pluginPath);

            File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());

            WaitUntil(() => watcher.Pending().Count > 0, TimeSpan.FromSeconds(3));

            var pending = Assert.Single(watcher.Pending());
            Assert.Equal(modFolder, pending.ModFolder);
            Assert.Equal("Test.esp", pending.PluginName);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    /// <summary>The debounce property itself: a write that just landed must not be classified before
    /// the debounce window elapses — a naive "classify on every Changed event" implementation would
    /// already have a pending question by the time this assertion runs.</summary>
    [Fact]
    public void Watch_DoesNotQueueAnythingBeforeTheDebounceWindowElapses()
    {
        var modFolder = NewModFolder();
        try
        {
            var pluginPath = Track(modFolder, "Test.esp", "original"u8.ToArray());
            using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(300));
            watcher.Watch(modFolder, "Test.esp", pluginPath);

            File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());
            Thread.Sleep(30); // well inside the 300ms debounce window

            Assert.Empty(watcher.Pending());
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
            using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
            watcher.Watch(modFolder, "Test.esp", pluginPath);

            // Re-writing the exact bytes the parked ref already names — Save & Compile's own write,
            // not an external change.
            File.WriteAllBytes(pluginPath, binary);
            Thread.Sleep(400);

            Assert.Empty(watcher.Pending());
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Unwatch_StopsQueuingFurtherChanges()
    {
        var modFolder = NewModFolder();
        try
        {
            var pluginPath = Track(modFolder, "Test.esp", "original"u8.ToArray());
            using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
            watcher.Watch(modFolder, "Test.esp", pluginPath);
            watcher.Unwatch(modFolder, "Test.esp");

            File.WriteAllBytes(pluginPath, "changed-after-unwatch"u8.ToArray());
            Thread.Sleep(400);

            Assert.Empty(watcher.Pending());
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }
}
