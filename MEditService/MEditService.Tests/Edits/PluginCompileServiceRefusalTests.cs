using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Edits;

/// <summary>A state compile structurally cannot emit is a typed refusal naming the reason, never an
/// exception and never a silently corrupted binary.</summary>
public sealed class PluginCompileServiceRefusalTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private PluginCompileService CompileService() =>
        _mod.CompileService();

    // Two different states with two different remedies: wait for Mod Management's snapshot, or add
    // the plugin to a load order that has already arrived.
    [Fact]
    public void Compile_BeforeAnyLoadOrderHasArrived_RefusesSayingSo()
    {
        var result = CompileServices.Over(LoadOrder.Empty).Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Equal("No load order has been received.", result.RefusalReason);
    }

    [Fact]
    public void Compile_OfAPluginTheArrivedLoadOrderDoesNotHold_RefusesNamingThePlugin()
    {
        var stranger = new PluginKey("Stranger.esp", CompileFixture.Origin);

        var result = _mod.CompileService().Compile(stranger, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Equal("Stranger.esp is not in the load order.", result.RefusalReason);
    }

    [Fact]
    public void Compile_WithTwoSourceFilesClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        // Two distinct source files, same FormKey — nothing the edit path can produce (a
        // rename/hand-edit/third-party tool could), and there is no way to emit it as two binary
        // records without changing one's FormKey.
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        var collidingPath = _mod.SourceFileFor(_mod.Npc, "Keyword", CompileFixture.NpcEditorId);
        Directory.CreateDirectory(Path.GetDirectoryName(collidingPath)!);
        File.WriteAllText(collidingPath, npcSourceText);

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }

    [Fact]
    public void Compile_WithTwoFilesInOneGroupFolderClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        // Asked of the tree, not the compiled mod: the whole-mod read ends each group with a
        // FormKey-keyed SetTo, so the pair collapses silently before compile ever sees it.
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        var duplicatePath = Path.Combine(_mod.ModFolder, SourceRepository.FlatPathFor(
            CompileFixture.PluginName, "npc_", _mod.Npc.ToString(), "CopyOfFixtureNpc", GameRelease.Fallout4));
        Assert.NotEqual(_mod.NpcSourceFile, duplicatePath);
        File.WriteAllText(duplicatePath, npcSourceText);

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason);
    }

    [Fact]
    public void Compile_WithUnparsableSourceFile_RefusesPointingAtReTrack()
    {
        File.WriteAllText(_mod.NpcSourceFile, "{ not valid json");

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains("Re-Track", result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }

    // The generated deserializer is lenient both ways — an unrecognized property is skipped, a
    // missing one left at its default — so a renamed key reproduces a breaking codec change exactly.
    [Fact]
    public void Compile_WithSourceFieldRenamedToOneTheCodecDoesNotRead_RefusesNamingTheFile()
    {
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        Assert.Contains("\"Race\"", npcSourceText);
        File.WriteAllText(_mod.NpcSourceFile, npcSourceText.Replace("\"Race\"", "\"RaceOld\""));

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains("Re-Track", result.RefusalReason);
        Assert.Contains(CompileFixture.NpcEditorId, result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }
}
