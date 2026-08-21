using System.Text.Json;
using MEditService.Bridge;
using MEditService.Core.Edits;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;

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
        var files = new[] { new PristineFile($"{plugin}.source/npc_/{plugin}/000001.json", "{}"u8.ToArray()) };
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

    /// <summary>
    /// #417 exit path 3, wired end to end: detection alone (before any dialog answer, before any
    /// Esc) is what refuses editing — <c>ExternalChangeDeferral.Pending</c> must already be set the
    /// instant a question is queued, not only once the user explicitly dismisses the dialog.
    /// </summary>
    [Fact]
    public void Watch_SetsTheExternalChangeDeferralMarker_AssoonAsAQuestionIsQueued()
    {
        var modFolder = NewModFolder();
        try
        {
            var pluginPath = Track(modFolder, "Test.esp", "original"u8.ToArray());
            using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
            watcher.Watch(modFolder, "Test.esp", pluginPath);
            Assert.Null(ExternalChangeDeferral.Pending(modFolder, "Test.esp"));

            File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());
            WaitUntil(() => watcher.Pending().Count > 0, TimeSpan.FromSeconds(3));

            var question = ExternalChangeDeferral.Pending(modFolder, "Test.esp");
            Assert.NotNull(question);
            Assert.Contains("Test.esp", question, StringComparison.Ordinal);
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

    /// <summary>
    /// #417 review fix 2: the end-to-end case the ruling actually asked for — a live watcher, and a
    /// REAL <see cref="PluginCompileService.Compile"/> (production's own rename-based commit,
    /// <see cref="PluginWriter.SaveFromModAsync"/>/<c>PreparedPluginSave.Commit</c>), not a hand-written
    /// byte-identical write standing in for one. Distinct from <see cref="Watch_DoesNotQueueASelfEcho"/>
    /// above (which proves the classifier-level compare, using a fabricated echo) and from
    /// <see cref="ExternalChangeClassifierTests.Classify_ReportsSelfEcho_ForTheBinaryARealCompileJustWrote"/>
    /// (which proves the same real-compile case but calls the classifier directly, bypassing the
    /// watcher's own event plumbing entirely).
    /// </summary>
    [Fact]
    public void Watch_DoesNotQueueTheBinary_ARealCompileJustWrote()
    {
        var mod = TrackedModFixture.Tracked();
        try
        {
            var pluginPath = Path.Combine(mod.ModFolder, TrackedModFixture.PluginName);
            using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
            watcher.Watch(mod.ModFolder, TrackedModFixture.PluginName, pluginPath);

            var editService = new RecordEditService(mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);
            editService.EditField(mod.Plugin, mod.Npc.ToString(), "height_max", JsonDocument.Parse("0.75").RootElement);
            var compileService = new PluginCompileService(mod.Sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);
            var result = compileService.Compile(mod.Plugin, new CompileSource.WorkingTree());
            Assert.True(result.Succeeded, result.RefusalReason);

            // Bounded, foreground wait past the debounce window — long enough that a real
            // suppression failure would show up as a queued item by the time this reads, short
            // enough to stay a fast test.
            Thread.Sleep(500);

            Assert.Empty(watcher.Pending());
        }
        finally
        {
            mod.Dispose();
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
