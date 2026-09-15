using MEditService.Commands.Edits;
using MEditService.SourceRepo;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>The flat half only: <see cref="CompileFixture"/>'s records are all non-container
/// types; containers are <c>PluginCompileServiceContainerTests</c>' job.</summary>
public sealed class PluginCompileServiceTests : IDisposable
{
    // Past the fixture's own records, and past its header's NextFormID: what a renumber or a create
    // allocates, and what an ObjectID below $800 could never be (engine-hardcoded range).
    private const uint RenumberedNpcId = 0x000900;
    private const uint CreatedNpcId = 0x000910;

    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private PluginCompileService CompileService() =>
        _mod.CompileService();

    private IFallout4ModGetter CompileAndReimport(out IDisposable handle)
    {
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var overlay = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CompileFixture.PluginName), pluginPath), GameRelease.Fallout4);
        handle = overlay;
        return (IFallout4ModGetter)overlay;
    }

    private List<string> NpcFiles() =>
        [.. Directory.GetFiles(Path.Combine(_mod.ModFolder, SourceRepository.RootFor(CompileFixture.PluginName), "Npcs"))
            .Select(Path.GetFileName)
            .Select(n => n!)
            .Order(StringComparer.Ordinal)];

    [Fact]
    public void Compile_AfterAnEdit_WritesABinaryThatReparsesWithTheChangeLanded()
    {
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CompileFixture.PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        var npc = overlay.Npcs.Single(n => n.FormKey == _mod.Npc);
        Assert.Equal(0.75f, npc.HeightMax);
    }

    [Fact]
    public void Compile_LeavesUntouchedRecordsUnchanged()
    {
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CompileFixture.PluginName), pluginPath), GameRelease.Fallout4);
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
            .Single(n => n.StartsWith(CompileFixture.OtherNpcEditorId, StringComparison.Ordinal));

        _mod.Remove(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId);

        // The survivor's file was not renamed for its sibling's departure.
        Assert.Equal([survivorNameBefore], NpcFiles());

        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            var survivor = Assert.Single(mod.Npcs);
            Assert.Equal(_mod.OtherNpc, survivor.FormKey);
            Assert.Equal(CompileFixture.OtherNpcEditorId, survivor.EditorID);
        }
    }

    [Fact]
    public void Compile_AfterRenumberingTheFirstOfTwo_Succeeds_WithBothRecordsPresent()
    {
        var renumbered = _mod.Renumber(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, RenumberedNpcId);
        Assert.Equal(2, NpcFiles().Count);

        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            Assert.DoesNotContain(mod.Npcs, n => n.FormKey == _mod.Npc);
            Assert.Contains(mod.Npcs, n => n.FormKey == renumbered);
            Assert.Contains(mod.Npcs, n => n.FormKey == _mod.OtherNpc);
        }
    }

    [Fact]
    public void Compile_AfterStackedDeletesCreatesAndARenumber_Succeeds_WithExactlyTheSurvivors()
    {
        var created1 = _mod.CreateNpc("Created1", CreatedNpcId);
        _mod.CreateNpc("Created2", CreatedNpcId + 1);
        _mod.Remove(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId);
        var renumbered = _mod.Renumber(
            _mod.OtherNpc, CompileFixture.NpcRecordType, CompileFixture.OtherNpcEditorId, RenumberedNpcId);
        _mod.Remove(created1, CompileFixture.NpcRecordType, "Created1");

        var mod = CompileAndReimport(out var handle);
        using (handle)
        {
            Assert.Equal(2, mod.Npcs.Count);
            Assert.Contains(mod.Npcs, n => n.FormKey == renumbered);
            Assert.Contains(mod.Npcs, n => n.EditorID == "Created2");
            Assert.DoesNotContain(mod.Npcs, n => n.FormKey == _mod.Npc);
            Assert.DoesNotContain(mod.Npcs, n => n.FormKey == created1);
        }
    }

    // The previous layout minted a group document the reader now skips silently. A file the codec
    // would not regenerate is a divergence named by path; re-Track is the recovery (ADR-0006).
    [Fact]
    public void Compile_OfATreeInThePreviousLayout_RefusesNamingTheLeftoverAndReTrack()
    {
        var leftover = Path.Combine(
            _mod.ModFolder, SourceRepository.RootFor(CompileFixture.PluginName), "Npcs", "GroupRecordData.json");
        Assert.False(File.Exists(leftover));
        File.WriteAllText(leftover, "{\"MEditChildOrder\": {\"Npcs\": [\"" + _mod.Npc + "\", \"" + _mod.OtherNpc + "\"]}}");

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains(Path.Combine("Npcs", "GroupRecordData.json"), result.RefusalReason, StringComparison.Ordinal);
        Assert.Contains("Re-Track", result.RefusalReason, StringComparison.Ordinal);
    }

    // Every write backs up the target plugin first; compile is a new write
    // path, not a new exemption from it.
    [Fact]
    public void Compile_LeavesATimestampedBackupBesideTheBinary()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var originalBytes = File.ReadAllBytes(pluginPath);

        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var backups = Directory.GetFiles(_mod.ModFolder, $"{Path.GetFileNameWithoutExtension(CompileFixture.PluginName)}.*.bak.esp");
        var backup = Assert.Single(backups);
        Assert.True(originalBytes.AsSpan().SequenceEqual(File.ReadAllBytes(backup)),
            "The backup should hold the pre-compile bytes, not the compiled output.");
    }
}
