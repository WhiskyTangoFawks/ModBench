using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginRefusalTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private CompilePluginHandler CompileService() =>
        _mod.CompileService();

    [Fact]
    public async Task Compile_BeforeAnyLoadOrderHasArrived_WritesNothingAndThrowsNoLoadOrder() =>
        await Assert.ThrowsAsync<NoLoadOrderException>(
            () => CompileServices.Over(LoadOrderSnapshot.Empty).CompileAsync([_mod.Plugin]));

    [Fact]
    public async Task Compile_OfAPluginTheArrivedLoadOrderDoesNotHold_RefusesNamingThePlugin()
    {
        var stranger = new PluginAddress("Stranger.esp", CompileFixture.Origin);

        var answer = await _mod.CompileService().CompileAsync([stranger]);

        var refused = Assert.Single(answer.Refused);
        Assert.Equal("Stranger.esp is not in the load order.", refused.Message);
    }

    [Fact]
    public async Task Compile_WithTwoDocumentsClaimingTheSameFormKey_RefusesNamingTheFormKey()
    {
        TreeTampering.Duplicate(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(_mod.Npc.ToString(), refused.Message);
    }

    [Fact]
    public async Task Compile_WithADocumentItCannotRead_RefusesNamingTheFile()
    {
        var file = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        using var held = TreeTampering.HoldOpen(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, file), refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WithUnparsableSourceFile_RefusesPointingAtDecompile()
    {
        _mod.Overwrite(_mod.NpcIdentity, "{ not valid json");

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains("Decompile the plugin to regenerate the source.", refused.Message);
        Assert.DoesNotContain("Track", refused.Message);
        Assert.Empty(answer.Landed);
    }

    [Fact]
    public async Task Compile_WithSourceFieldRenamedToOneTheCodecDoesNotRead_RefusesNamingTheFileAndDecompile()
    {
        var npcSourceText = _mod.Document(_mod.Npc.ToString()).Require().Body;
        Assert.Contains("\"Race\"", npcSourceText);
        _mod.Overwrite(_mod.NpcIdentity, npcSourceText.Replace("\"Race\"", "\"RaceOld\""));

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains("Decompile the plugin to regenerate the source.", refused.Message);
        Assert.DoesNotContain("Track", refused.Message);
        Assert.Contains(CompileFixture.NpcEditorId, refused.Message);
        Assert.Empty(answer.Landed);
    }
}
