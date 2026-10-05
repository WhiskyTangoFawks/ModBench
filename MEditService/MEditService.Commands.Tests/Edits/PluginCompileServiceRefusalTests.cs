using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class PluginCompileServiceRefusalTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private CompilePluginHandler CompileService() =>
        _mod.CompileService();

    [Fact]
    public async Task Compile_BeforeAnyLoadOrderHasArrived_RefusesSayingSo()
    {
        var result = await CompileServices.Over(LoadOrderSnapshot.Empty).CompileOneAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Equal("No load order has been received.", result.RefusalReason);
    }

    [Fact]
    public async Task Compile_OfAPluginTheArrivedLoadOrderDoesNotHold_RefusesNamingThePlugin()
    {
        var stranger = new PluginAddress("Stranger.esp", CompileFixture.Origin);

        var result = await _mod.CompileService().CompileOneAsync(stranger);

        Assert.False(result.Succeeded);
        Assert.Equal("Stranger.esp is not in the load order.", result.RefusalReason);
    }

    [Fact]
    public async Task Compile_WithTwoDocumentsClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        TreeTampering.Duplicate(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var result = await CompileService().CompileOneAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason);
    }

    [Fact]
    public async Task Compile_WithADocumentItCannotRead_RefusesNamingTheFile()
    {
        var file = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        using var held = TreeTampering.HoldOpen(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var result = await CompileService().CompileOneAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, file), result.RefusalReason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WithUnparsableSourceFile_RefusesPointingAtDecompile()
    {
        _mod.Overwrite(_mod.NpcIdentity, "{ not valid json");

        var result = await CompileService().CompileOneAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains("Run \"Modbench: Decompile Plugin\" to regenerate the source.", result.RefusalReason);
        Assert.DoesNotContain("Track", result.RefusalReason);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public async Task Compile_WithSourceFieldRenamedToOneTheCodecDoesNotRead_RefusesNamingTheFileAndDecompile()
    {
        var npcSourceText = _mod.Document(_mod.Npc.ToString()).Require().Body;
        Assert.Contains("\"Race\"", npcSourceText);
        _mod.Overwrite(_mod.NpcIdentity, npcSourceText.Replace("\"Race\"", "\"RaceOld\""));

        var result = await CompileService().CompileOneAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains("Run \"Modbench: Decompile Plugin\" to regenerate the source.", result.RefusalReason);
        Assert.DoesNotContain("Track", result.RefusalReason);
        Assert.Contains(CompileFixture.NpcEditorId, result.RefusalReason);
        Assert.Empty(result.Diagnostics);
    }
}
