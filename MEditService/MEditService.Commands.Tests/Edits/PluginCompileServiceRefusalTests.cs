using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.TestSupport.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

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
    public async Task Compile_BeforeAnyLoadOrderHasArrived_RefusesSayingSo()
    {
        var result = await CompileServices.Over(LoadOrderSnapshot.Empty).CompileAsync(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Equal("No load order has been received.", result.RefusalReason);
    }

    [Fact]
    public async Task Compile_OfAPluginTheArrivedLoadOrderDoesNotHold_RefusesNamingThePlugin()
    {
        var stranger = new PluginCopyKey("Stranger.esp", CompileFixture.Origin);

        var result = await _mod.CompileService().CompileAsync(stranger, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Equal("Stranger.esp is not in the load order.", result.RefusalReason);
    }

    [Fact]
    public async Task Compile_WithTwoSourceFilesClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        // Two distinct source files, same FormKey — nothing the edit path can produce (a
        // rename/hand-edit/third-party tool could), and there is no way to emit it as two binary
        // records without changing one's FormKey.
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        var collidingPath = _mod.SourceFileFor(_mod.Npc, "Keyword", CompileFixture.NpcEditorId);
        Directory.CreateDirectory((Path.GetDirectoryName(collidingPath) ?? throw new InvalidOperationException("Expected a parent directory.")));
        File.WriteAllText(collidingPath, npcSourceText);

        var result = await CompileService().CompileAsync(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }

    [Fact]
    public async Task Compile_WithTwoFilesInOneGroupFolderClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        // Asked of the tree, not the compiled mod: the whole-mod read ends each group with a
        // FormKey-keyed SetTo, so the pair collapses silently before compile ever sees it.
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        // The name still has to round-trip to the NPC's own FormKey — only the EditorID half differs —
        // or compile would refuse the mismatch before it ever reaches the duplicate check under test.
        var duplicatePath = Path.Combine(
            (Path.GetDirectoryName(_mod.NpcSourceFile) ?? throw new InvalidOperationException("Expected a parent directory.")), $"CopyOfFixtureNpc - {_mod.Npc.ID:X6}_{CompileFixture.PluginName}.json");
        // Guards the arrangement itself: a leaf this close to the real one must still land beside it,
        // never overwrite it, or the "two files" premise below is false.
        Assert.NotEqual(_mod.NpcSourceFile, duplicatePath);
        File.WriteAllText(duplicatePath, npcSourceText);

        var result = await CompileService().CompileAsync(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason);
    }

    // Never exclusive owners of the tree (ADR-0003): a document another program is holding open is
    // content this compile does not have, and omitting it would write a binary missing that record.
    [Fact]
    public async Task Compile_WithASourceFileItCannotRead_RefusesNamingTheFile()
    {
        using var held = new FileStream(_mod.NpcSourceFile, FileMode.Open, FileAccess.Read, FileShare.None);

        var result = await CompileService().CompileAsync(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains(
            Path.GetRelativePath(_mod.ModFolder, _mod.NpcSourceFile), result.RefusalReason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WithUnparsableSourceFile_RefusesPointingAtReTrack()
    {
        File.WriteAllText(_mod.NpcSourceFile, "{ not valid json");

        var result = await CompileService().CompileAsync(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains("Re-Track", result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }

    // The generated deserializer is lenient both ways — an unrecognized property is skipped, a
    // missing one left at its default — so a renamed key reproduces a breaking codec change exactly.
    [Fact]
    public async Task Compile_WithSourceFieldRenamedToOneTheCodecDoesNotRead_RefusesNamingTheFile()
    {
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        Assert.Contains("\"Race\"", npcSourceText);
        File.WriteAllText(_mod.NpcSourceFile, npcSourceText.Replace("\"Race\"", "\"RaceOld\""));

        var result = await CompileService().CompileAsync(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains("Re-Track", result.RefusalReason);
        Assert.Contains(CompileFixture.NpcEditorId, result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }
}
