using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Source;

/// <summary>
/// <see cref="ExternalChangeClassifier"/> — self-echo suppression, crash-marker
/// suppression, and the meta tell, against real tracked-mod fixtures (never a mocked git or a
/// mocked compile).
/// </summary>
public sealed class ExternalChangeClassifierTests
{
    private static string NewModFolder() => Directory.CreateTempSubdirectory("medit-classify-").FullName;
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // ── Self-echo: proven with a REAL Compile, not a fabricated matching hash. ──

    [Fact]
    public void Classify_ReportsSelfEcho_ForTheBinaryARealCompileJustWrote()
    {
        var mod = TrackedModFixture.Tracked();
        try
        {
            var editService = new RecordEditService(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);
            editService.EditField(mod.Plugin, mod.Npc.ToString(), "height_max", Json("0.75"));

            var compileService = new PluginCompileService(mod.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);
            var result = compileService.Compile(mod.Plugin, new CompileSource.WorkingTree());
            Assert.True(result.Succeeded, result.RefusalReason);

            var binaryBytes = File.ReadAllBytes(Path.Combine(mod.ModFolder, TrackedModFixture.PluginName));
            var classification = ExternalChangeClassifier.Classify(mod.ModFolder, TrackedModFixture.PluginName, binaryBytes);

            Assert.IsType<ExternalChangeClassification.SelfEcho>(classification);
        }
        finally
        {
            mod.Dispose();
        }
    }

    [Fact]
    public void Classify_ReportsExternalChange_ForBytesTheParkedRefDoesNotName()
    {
        var mod = TrackedModFixture.Tracked();
        try
        {
            var classification = ExternalChangeClassifier.Classify(mod.ModFolder, TrackedModFixture.PluginName, "not the tracked binary"u8.ToArray());

            Assert.IsType<ExternalChangeClassification.ExternalChange>(classification);
        }
        finally
        {
            mod.Dispose();
        }
    }

    // ── Crash-marker suppression: crash recovery's territory, never the external-change dialog for the same event. ──

    [Fact]
    public void Classify_ReportsCrashRecovery_WhenAJournalMarkerIsUnfinished_EvenWithAHashMismatch()
    {
        var modFolder = NewModFolder();
        try
        {
            Track(modFolder, "Test.esp");

            // A batch that never lands — CompileJournal.RunBatch's own marker stays unlanded because
            // landed.Count never reaches plugins.Count (root CLAUDE.md: exercise the real seam, not
            // a hand-written marker file).
            CompileJournal.RunBatch(modFolder, ["Test.esp"], _ => false);

            var classification = ExternalChangeClassifier.Classify(modFolder, "Test.esp", "anything, hash mismatches regardless"u8.ToArray());

            Assert.IsType<ExternalChangeClassification.CrashRecovery>(classification);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    /// <summary>
    /// The discriminating case for check <i>order</i>: an unlanded marker in the same repo (for any
    /// plugin — the marker is per-repo, not per-plugin, per <see cref="CompileJournal"/>'s own doc
    /// comment) alongside a binary whose hash *does* match the parked ref (a genuine self-echo
    /// condition on its own). Marker wins regardless: the two prompts
    /// must never both fire for one event, and an interrupted batch is the more urgent, more certain
    /// signal even when the surviving hash happens to still agree with the parked ref.
    /// </summary>
    [Fact]
    public void Classify_ReportsCrashRecovery_EvenWhenTheHashAlsoMatchesTheParkedRef()
    {
        var mod = TrackedModFixture.Tracked();
        try
        {
            var editService = new RecordEditService(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);
            editService.EditField(mod.Plugin, mod.Npc.ToString(), "height_max", Json("0.75"));
            var compileService = new PluginCompileService(mod.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);
            var result = compileService.Compile(mod.Plugin, new CompileSource.WorkingTree());
            Assert.True(result.Succeeded, result.RefusalReason);

            // A stale marker left by an unrelated interrupted batch in the same repo — the journal is
            // one marker per .git, not one per plugin.
            CompileJournal.RunBatch(mod.ModFolder, ["SomeOtherPlugin.esp"], _ => false);

            var binaryBytes = File.ReadAllBytes(Path.Combine(mod.ModFolder, TrackedModFixture.PluginName));
            var classification = ExternalChangeClassifier.Classify(mod.ModFolder, TrackedModFixture.PluginName, binaryBytes);

            Assert.IsType<ExternalChangeClassification.CrashRecovery>(classification);
        }
        finally
        {
            mod.Dispose();
        }
    }

    // ── The meta tell: default-button evidence, never acted on by itself (ADR-0041 amendment). ──

    [Fact]
    public void Classify_ReportsMetaChanged_WhenMetaIniVersionMovedSinceTheBaseline()
    {
        var modFolder = NewModFolder();
        try
        {
            File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "version=1.0.0\n");
            Track(modFolder, "Test.esp");
            File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "version=2.0.0\n");

            var classification = ExternalChangeClassifier.Classify(modFolder, "Test.esp", "an external binary"u8.ToArray());

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

    [Fact]
    public void Classify_ReportsMetaUnchanged_WhenThereIsNoMetaIniAtAll()
    {
        var modFolder = NewModFolder();
        try
        {
            Track(modFolder, "Test.esp");

            var classification = ExternalChangeClassifier.Classify(modFolder, "Test.esp", "an external binary"u8.ToArray());

            var change = Assert.IsType<ExternalChangeClassification.ExternalChange>(classification);
            Assert.False(change.MetaChanged);
        }
        finally
        {
            Directory.Delete(modFolder, recursive: true);
        }
    }

    [Fact]
    public void Classify_ReturnsNull_ForAnUntrackedFolder()
    {
        var modFolder = NewModFolder();
        try
        {
            Assert.Null(ExternalChangeClassifier.Classify(modFolder, "Test.esp", "anything"u8.ToArray()));
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
}
