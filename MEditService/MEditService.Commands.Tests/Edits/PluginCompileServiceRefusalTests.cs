using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;

namespace MEditService.Commands.Tests.Edits;

public sealed class PluginCompileServiceRefusalTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private PluginCompileService CompileService() =>
        _mod.CompileService();

    [Fact]
    public async Task Compile_BeforeAnyLoadOrderHasArrived_RefusesSayingSo()
    {
        var result = await CompileServices.Over(LoadOrderSnapshot.Empty).CompileAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Equal("No load order has been received.", result.RefusalReason);
    }

    [Fact]
    public async Task Compile_OfAPluginTheArrivedLoadOrderDoesNotHold_RefusesNamingThePlugin()
    {
        var stranger = new PluginAddress("Stranger.esp", CompileFixture.Origin);

        var result = await _mod.CompileService().CompileAsync(stranger);

        Assert.False(result.Succeeded);
        Assert.Equal("Stranger.esp is not in the load order.", result.RefusalReason);
    }

    [Fact]
    public async Task Compile_WithTwoSourceFilesClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        var collidingPath = _mod.SourceFileFor(_mod.Npc, "Keyword", CompileFixture.NpcEditorId);
        Directory.CreateDirectory(Path.GetDirectoryName(collidingPath) ?? throw new InvalidOperationException($"Expected '{collidingPath}' to have a parent directory."));
        File.WriteAllText(collidingPath, npcSourceText);

        var result = await CompileService().CompileAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }

    [Fact]
    public async Task Compile_WithTwoFilesInOneGroupFolderClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        var npcSourceFile = _mod.NpcSourceFile;
        var duplicatePath = Path.Combine(
            Path.GetDirectoryName(npcSourceFile) ?? throw new InvalidOperationException($"Expected '{npcSourceFile}' to have a parent directory."),
            $"CopyOfFixtureNpc - {_mod.Npc.ID:X6}_{CompileFixture.PluginName}.json");
        Assert.NotEqual(_mod.NpcSourceFile, duplicatePath);
        File.WriteAllText(duplicatePath, npcSourceText);

        var result = await CompileService().CompileAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason);
    }

    [Fact]
    public async Task Compile_WithASourceFileItCannotRead_RefusesNamingTheFile()
    {
        using var held = new FileStream(_mod.NpcSourceFile, FileMode.Open, FileAccess.Read, FileShare.None);

        var result = await CompileService().CompileAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains(
            Path.GetRelativePath(_mod.ModFolder, _mod.NpcSourceFile), result.RefusalReason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WithUnparsableSourceFile_RefusesPointingAtReTrack()
    {
        File.WriteAllText(_mod.NpcSourceFile, "{ not valid json");

        var result = await CompileService().CompileAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains("Re-Track", result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }

    [Fact]
    public async Task Compile_WithSourceFieldRenamedToOneTheCodecDoesNotRead_RefusesNamingTheFile()
    {
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        Assert.Contains("\"Race\"", npcSourceText);
        File.WriteAllText(_mod.NpcSourceFile, npcSourceText.Replace("\"Race\"", "\"RaceOld\""));

        var result = await CompileService().CompileAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains("Re-Track", result.RefusalReason);
        Assert.Contains(CompileFixture.NpcEditorId, result.RefusalReason);
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Masters);
    }
}
