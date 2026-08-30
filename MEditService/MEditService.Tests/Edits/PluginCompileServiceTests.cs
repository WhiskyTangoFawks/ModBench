using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// #416 S1: Save &amp; Compile's core promise — editing a plain (non-container) record's field and
/// compiling writes a binary that re-parses with the edit landed, and every untouched record
/// unchanged. <see cref="TrackedModFixture"/>'s three records (Npc/Race/Keyword/OtherNpc) are all
/// top-level, non-container types, so this exercises the flat half of the tree only — containers
/// (cells, worldspaces, quests, dialogue) are <see cref="PluginCompileServiceContainerTests"/>' job on
/// a small readable fixture, and <c>RealData/CompileRoundTripGateTests</c>' at scale against the real
/// #369 fixture.
/// </summary>
public sealed class PluginCompileServiceTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService EditService() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private PluginCompileService CompileService() =>
        new(_mod.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void Compile_AfterAnEdit_WritesABinaryThatReparsesWithTheChangeLanded()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

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
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));
        CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(TrackedModFixture.PluginName), pluginPath), GameRelease.Fallout4);
        var overlay = (IFallout4ModGetter)overlayDisposable;

        Assert.Contains(overlay.Npcs, n => n.FormKey == _mod.OtherNpc);
        Assert.Contains(overlay.Races, r => r.FormKey == _mod.Race);
        Assert.Contains(overlay.Keywords, k => k.FormKey == _mod.Keyword);
    }

    // #416 S5: semantic breakage compiles *successfully*, with diagnostics — never a refusal.
    // TrackedModFixture's Race carries genuinely unset FormLink fields (severable/explodable
    // explosion+debris, never edited or configured by this fixture), which CheckErrorBuilder already
    // flags for the editor (DuckDbRecordIndex.GetDocument) — compile surfaces the same diagnostics
    // rather than re-deriving a second definition of "broken", and still writes the binary.
    [Fact]
    public void Compile_WithASemanticallyBrokenRecord_SucceedsWithDiagnostics()
    {
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.Contains(result.Diagnostics, d => d.FormKey == _mod.Race.ToString());
    }

    // #416 S6: every write backs up the target plugin first (ADR-0008) — compile is a new write
    // path, not a new exemption from it.
    [Fact]
    public void Compile_LeavesATimestampedBackupBesideTheBinary()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        var originalBytes = File.ReadAllBytes(pluginPath);

        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var backups = Directory.GetFiles(_mod.ModFolder, $"{Path.GetFileNameWithoutExtension(TrackedModFixture.PluginName)}.*.bak.esp");
        var backup = Assert.Single(backups);
        Assert.True(originalBytes.AsSpan().SequenceEqual(File.ReadAllBytes(backup)),
            "The backup should hold the pre-compile bytes, not the compiled output.");
    }
}
