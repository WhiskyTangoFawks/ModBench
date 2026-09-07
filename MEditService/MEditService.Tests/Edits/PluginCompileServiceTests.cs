using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>The flat half only: <see cref="TrackedModFixture"/>'s records are all non-container
/// types; containers are <c>PluginCompileServiceContainerTests</c>' job.</summary>
public sealed class PluginCompileServiceTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private ProjectingEditService EditService() =>
        ProjectingEditService.Over(_mod.Mirror);

    private PluginCompileService CompileService() =>
        new(_mod.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private IFallout4ModGetter CompileAndReimport(out IDisposable handle)
    {
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(TrackedModFixture.PluginName), pluginPath), GameRelease.Fallout4);
        handle = overlay;
        return (IFallout4ModGetter)overlay;
    }

    private List<string> NpcFiles() =>
        [.. Directory.GetFiles(Path.Combine(_mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName), "Npcs"))
            .Select(Path.GetFileName)
            .Select(n => n!)
            .Order(StringComparer.Ordinal)];

    [Fact]
    public void Compile_AfterAnEdit_WritesABinaryThatReparsesWithTheChangeLanded()
    {
        EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(TrackedModFixture.PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        var npc = overlay.Npcs.Single(n => n.FormKey == _mod.Npc);
        Assert.Equal(0.75f, npc.HeightMax);
    }

    [Fact]
    public void Compile_LeavesUntouchedRecordsUnchanged()
    {
        EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));
        CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(TrackedModFixture.PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        Assert.Contains(overlay.Npcs, n => n.FormKey == _mod.OtherNpc);
        Assert.Contains(overlay.Races, r => r.FormKey == _mod.Race);
        Assert.Contains(overlay.Keywords, k => k.FormKey == _mod.Keyword);
    }

    // Semantic breakage compiles successfully with diagnostics, never a refusal. The fixture's Race
    // carries genuinely unset FormLink fields, which CheckErrorBuilder already flags for the editor;
    // compile surfaces the same diagnostics rather than re-deriving a second definition of "broken".
    [Fact]
    public void Compile_WithASemanticallyBrokenRecord_SucceedsWithDiagnostics()
    {
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.Contains(result.Diagnostics, d => d.FormKey == _mod.Race.ToString());
    }

    [Fact]
    public void Compile_AfterDeletingTheFirstOfTwoSameTypeRecords_Succeeds_AndTheBinaryReflectsTheDelete()
    {
        var survivorNameBefore = NpcFiles()
            .Single(n => n.StartsWith(TrackedModFixture.OtherNpcEditorId, StringComparison.Ordinal));

        var deleted = EditService().DeleteRecord(_mod.Plugin, _mod.Npc.ToString());
        Assert.True(deleted.Applied, deleted.Message);

        // The survivor's file was not renamed for its sibling's departure.
        Assert.Equal([survivorNameBefore], NpcFiles());

        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            var survivor = Assert.Single(mod.Npcs);
            Assert.Equal(_mod.OtherNpc, survivor.FormKey);
            Assert.Equal(TrackedModFixture.OtherNpcEditorId, survivor.EditorID);
        }
    }

    [Fact]
    public void Compile_AfterRenumberingTheFirstOfTwo_Succeeds_WithBothRecordsPresent()
    {
        var result = EditService().RenumberRecord(_mod.Plugin, _mod.Npc.ToString());
        Assert.True(result.Applied, result.Message);
        Assert.Equal(2, NpcFiles().Count);

        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            Assert.DoesNotContain(mod.Npcs, n => n.FormKey == _mod.Npc);
            Assert.Contains(mod.Npcs, n => n.FormKey.ToString() == result.NewFormKey);
            Assert.Contains(mod.Npcs, n => n.FormKey == _mod.OtherNpc);
        }
    }

    [Fact]
    public void Compile_AfterDeletingTheMiddleOfThreeDialogTopics_Succeeds_KeepingSurvivorsInOrder()
    {
        using var container = new ContainerModFixture();
        var editService = ProjectingEditService.Over(container.Mirror);
        var compileService = new PluginCompileService(
            container.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

        var deleted = editService.DeleteRecord(container.Plugin, container.DialogTopic2.ToString());
        Assert.True(deleted.Applied, deleted.Message);

        var result = compileService.Compile(container.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(container.ModFolder, ContainerModFixture.PluginName);
        using var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(ContainerModFixture.PluginName), pluginPath), GameRelease.Fallout4);
        var quest = ((IFallout4ModGetter)overlay).Quests.Single(q => q.FormKey == container.Quest);
        Assert.Equal(
            [ContainerModFixture.DialogTopicEditorId, ContainerModFixture.DialogTopic3EditorId],
            quest.DialogTopics.Select(t => t.EditorID!).ToArray());
    }

    [Fact]
    public void Compile_AfterStackedDeletesCreatesAndARenumber_Succeeds_WithExactlyTheSurvivors()
    {
        var service = EditService();

        var created1 = service.CreateRecord(_mod.Plugin, "npc_", "Created1");
        var created2 = service.CreateRecord(_mod.Plugin, "npc_", "Created2");
        Assert.True(created1.Applied, created1.Message);
        Assert.True(created2.Applied, created2.Message);

        var deleted1 = service.DeleteRecord(_mod.Plugin, _mod.Npc.ToString());
        Assert.True(deleted1.Applied, deleted1.Message);

        var renumbered = service.RenumberRecord(_mod.Plugin, _mod.OtherNpc.ToString());
        Assert.True(renumbered.Applied, renumbered.Message);

        var deleted2 = service.DeleteRecord(_mod.Plugin, FormKey.Factory(created1.NewFormKey!).ToString());
        Assert.True(deleted2.Applied, deleted2.Message);

        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            Assert.Equal(2, mod.Npcs.Count);
            Assert.Contains(mod.Npcs, n => n.FormKey.ToString() == renumbered.NewFormKey);
            Assert.Contains(mod.Npcs, n => n.EditorID == "Created2");
            Assert.DoesNotContain(mod.Npcs, n => n.FormKey == _mod.Npc);
            Assert.DoesNotContain(mod.Npcs, n => n.FormKey.ToString() == created1.NewFormKey);
        }
    }

    // The previous layout minted a group document the reader now skips silently. A file the codec
    // would not regenerate is a divergence named by path; re-Track is the recovery (ADR-0042).
    [Fact]
    public void Compile_OfATreeInThePreviousLayout_RefusesNamingTheLeftoverAndReTrack()
    {
        var leftover = Path.Combine(
            _mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName), "Npcs", "GroupRecordData.json");
        Assert.False(File.Exists(leftover));
        File.WriteAllText(leftover, "{\"MEditChildOrder\": {\"Npcs\": [\"" + _mod.Npc + "\", \"" + _mod.OtherNpc + "\"]}}");

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains(Path.Combine("Npcs", "GroupRecordData.json"), result.RefusalReason, StringComparison.Ordinal);
        Assert.Contains("Re-Track", result.RefusalReason, StringComparison.Ordinal);
    }

    // Every write backs up the target plugin first (ADR-0008) — compile is a new write
    // path, not a new exemption from it.
    [Fact]
    public void Compile_LeavesATimestampedBackupBesideTheBinary()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        var originalBytes = File.ReadAllBytes(pluginPath);

        EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var backups = Directory.GetFiles(_mod.ModFolder, $"{Path.GetFileNameWithoutExtension(TrackedModFixture.PluginName)}.*.bak.esp");
        var backup = Assert.Single(backups);
        Assert.True(originalBytes.AsSpan().SequenceEqual(File.ReadAllBytes(backup)),
            "The backup should hold the pre-compile bytes, not the compiled output.");
    }
}
