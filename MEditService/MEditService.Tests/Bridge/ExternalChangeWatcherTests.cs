using System.Text.Json;
using MEditService.Bridge;
using MEditService.Core.Edits;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Bridge;

public sealed class ExternalChangeWatcherTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-watch-").FullName;

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

    [Fact]
    public void Watch_QueuesAnUnansweredExternalChange_WhenTheWatchedBinaryChanges()
    {
        var modFolder = NewModFolder();
        try
        {
            var pluginPath = Track(modFolder, "Test.esp", "original"u8.ToArray());
            using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
            watcher.Watch(modFolder, "Test.esp", pluginPath);

            File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());

            WaitUntil(() => watcher.Unanswered().Count > 0, TimeSpan.FromSeconds(3));

            var unanswered = Assert.Single(watcher.Unanswered());
            Assert.Equal(modFolder, unanswered.ModFolder);
            Assert.Equal("Test.esp", unanswered.PluginName);
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
            using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
            watcher.Watch(modFolder, "Test.esp", pluginPath);
            Assert.Null(ExternalChangeDeferral.Unanswered(modFolder, "Test.esp"));

            File.WriteAllBytes(pluginPath, "changed-by-xedit"u8.ToArray());
            WaitUntil(() => watcher.Unanswered().Count > 0, TimeSpan.FromSeconds(3));

            var question = ExternalChangeDeferral.Unanswered(modFolder, "Test.esp");
            Assert.NotNull(question);
            Assert.Contains("Test.esp", question, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

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
            using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
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
        var mod = TrackedModFixture.Tracked();
        try
        {
            var pluginPath = Path.Combine(mod.ModFolder, TrackedModFixture.PluginName);
            using var watcher = new ExternalChangeWatcher(TimeSpan.FromMilliseconds(100));
            watcher.Watch(mod.ModFolder, TrackedModFixture.PluginName, pluginPath);

            var editService = ProjectingEditService.Over(mod.Mirror);
            editService.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);
            var compileService = new PluginCompileService(mod.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);
            var result = compileService.Compile(mod.Plugin, new CompileSource.WorkingTree());
            Assert.True(result.Succeeded, result.RefusalReason);

            // Bounded, foreground wait past the debounce window — long enough that a real
            // suppression failure would show up as a queued item by the time this reads, short
            // enough to stay a fast test.
            Thread.Sleep(500);

            Assert.Empty(watcher.Unanswered());
        }
        finally
        {
            mod.Dispose();
        }
    }
}
