using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Source;

public sealed class ExternalChangeClassifierTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-classify-").FullName;
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static (string PluginName, byte[] ObservedBytes) Plugin(string name, byte[] bytes) => (name, bytes);

    // ── Self-echo: proven with a REAL Compile, not a fabricated matching hash. ──

    [Fact]
    public void ClassifyMod_ReportsNothing_ForTheBinaryARealCompileJustWrote()
    {
        var mod = SourceEditFixture.Tracked();
        try
        {
            mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", Json("0.75"));
            var compileService = CompileServices.Over(mod.LoadOrder);
            var result = compileService.Compile(mod.Plugin, new CompileSource.WorkingTree());
            Assert.True(result.Succeeded, result.RefusalReason);

            var binaryBytes = File.ReadAllBytes(Path.Combine(mod.ModFolder, SourceEditFixture.PluginName));
            var classification = ExternalChangeClassifier.ClassifyMod(
                mod.ModFolder, [Plugin(SourceEditFixture.PluginName, binaryBytes)]);

            Assert.Null(classification);
        }
        finally
        {
            mod.Dispose();
        }
    }

    [Fact]
    public void ClassifyMod_ReportsTheChangedPlugin_ForBytesTheParkedRefDoesNotName()
    {
        var mod = SourceEditFixture.Tracked();
        try
        {
            var classification = ExternalChangeClassifier.ClassifyMod(
                mod.ModFolder, [Plugin(SourceEditFixture.PluginName, "not the tracked binary"u8.ToArray())]);

            var change = Assert.IsType<ExternalChangeClassification.ExternalChange>(classification);
            Assert.Equal([SourceEditFixture.PluginName], change.Plugins);
            Assert.Empty(change.TrackedFiles);
        }
        finally
        {
            mod.Dispose();
        }
    }

    // ── Crash-marker suppression: crash recovery's territory, never the external-change dialog for the same event. ──

    [Fact]
    public void ClassifyMod_ReportsCrashRecovery_WhenAJournalMarkerIsUnfinished_EvenWithAHashMismatch()
    {
        var modFolder = NewModFolder();
        try
        {
            Track(modFolder, "Test.esp");
            CompileJournal.RunBatch(modFolder, ["Test.esp"], _ => false);

            var classification = ExternalChangeClassifier.ClassifyMod(
                modFolder, [Plugin("Test.esp", "anything, hash mismatches regardless"u8.ToArray())]);

            Assert.IsType<ExternalChangeClassification.CrashRecovery>(classification);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // ── The meta tell: default-button evidence, never acted on by itself (ADR-0003). ──

    [Fact]
    public void ClassifyMod_ReportsMetaChanged_WhenMetaIniVersionMovedSinceTheBaseline()
    {
        var modFolder = NewModFolder();
        try
        {
            File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "version=1.0.0\n");
            Track(modFolder, "Test.esp");
            File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "version=2.0.0\n");

            var classification = ExternalChangeClassifier.ClassifyMod(
                modFolder, [Plugin("Test.esp", "an external binary"u8.ToArray())]);

            var change = Assert.IsType<ExternalChangeClassification.ExternalChange>(classification);
            Assert.True(change.MetaChanged);
            Assert.Equal("1.0.0", change.OldVersion);
            Assert.Equal("2.0.0", change.NewVersion);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // A meta.ini edit with no accompanying plugin or tracked-file change raises nothing at all —
    // the rule's "meta.ini is a tell, never a trigger" half.
    [Fact]
    public void ClassifyMod_ReportsNothing_ForAMetaIniEditAlone()
    {
        var modFolder = NewModFolder();
        try
        {
            File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "version=1.0.0\n");
            Track(modFolder, "Test.esp");
            File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "version=2.0.0\n");

            var classification = ExternalChangeClassifier.ClassifyMod(modFolder, []);

            Assert.Null(classification);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void ClassifyMod_ReturnsNull_ForAnUntrackedFolder()
    {
        var modFolder = NewModFolder();
        try
        {
            Assert.Null(ExternalChangeClassifier.ClassifyMod(modFolder, [Plugin("Test.esp", "anything"u8.ToArray())]));
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    // ── The tracked-file half: git's own status against the edit branch, outside source/. ──

    [Fact]
    public void ClassifyMod_ReportsTheChangedPath_ForATrackedAssetGitSeesDiffer_WithNoPluginTouched()
    {
        var modFolder = NewModFolder();
        try
        {
            File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "original");
            TrackEverything(modFolder, "Test.esp");
            File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "changed-by-the-release");

            var classification = ExternalChangeClassifier.ClassifyMod(modFolder, []);

            var change = Assert.IsType<ExternalChangeClassification.ExternalChange>(classification);
            Assert.Empty(change.Plugins);
            Assert.Equal(["texture.dds"], change.TrackedFiles);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void ClassifyMod_ReportsBothHalves_WhenAPluginAndATrackedAssetBothChanged()
    {
        var modFolder = NewModFolder();
        try
        {
            File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "original");
            TrackEverything(modFolder, "Test.esp");
            File.WriteAllText(Path.Combine(modFolder, "texture.dds"), "changed-by-the-release");

            var classification = ExternalChangeClassifier.ClassifyMod(
                modFolder, [Plugin("Test.esp", "an external binary"u8.ToArray())]);

            var change = Assert.IsType<ExternalChangeClassification.ExternalChange>(classification);
            Assert.Equal(["Test.esp"], change.Plugins);
            Assert.Equal(["texture.dds"], change.TrackedFiles);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    private static void Track(string modFolder, string plugin)
    {
        var files = new[] { new PristineFile($"source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray()) };
        var trailers = new TrackProvenance(MetaIni.ReadVersion(modFolder), MetaIni.ComputeSha256(modFolder), new Dictionary<string, string> { [plugin] = "0000000000" });
        SourceRepository.Track(modFolder, SourcePreset.Edits, files, trailers);
    }

    private static void TrackEverything(string modFolder, string plugin)
    {
        var files = new[] { new PristineFile($"source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray()) };
        var trailers = new TrackProvenance(MetaIni.ReadVersion(modFolder), MetaIni.ComputeSha256(modFolder), new Dictionary<string, string> { [plugin] = "0000000000" });
        SourceRepository.Track(modFolder, SourcePreset.Everything, files, trailers);
    }
}
