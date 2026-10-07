using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginHandlerTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public async Task ASelectionNamingAPluginTwice_CompilesItOnce()
    {
        var spelledAgain = new PluginAddress(_mod.Plugin.Name.ToUpperInvariant(), _mod.Plugin.Origin);

        var result = await _mod.CompileHandler.CompileAsync([_mod.Plugin, spelledAgain]);

        Assert.Empty(result.Refused);
        Assert.Equal([_mod.Plugin], result.Landed.Select(landed => landed.Item));
    }

    [Fact]
    public async Task APluginTheLoadOrderDoesNotHold_IsRefusedByType_AndTheOthersCompile()
    {
        var stranger = new PluginAddress("Stranger.esp", CompileFixture.Origin);

        var result = await _mod.CompileHandler.CompileAsync([stranger, _mod.Plugin]);

        Assert.Equal([_mod.Plugin], result.Landed.Select(landed => landed.Item));
        var refused = Assert.Single(result.Refused);
        Assert.Equal((stranger, CompileRefusal.PluginNotInLoadOrder), (refused.Item, refused.Refusal));
        Assert.Equal("Stranger.esp is not in the load order.", refused.Message);
    }

    [Fact]
    public async Task APluginWhoseSourceIsUnreadable_IsRefusedBeforeAnyWrite_NamingDecompile()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var before = File.ReadAllBytes(pluginPath);
        Directory.Delete(PluginSourceRoot.In(_mod.ModFolder, CompileFixture.PluginName), recursive: true);

        var result = await _mod.CompileHandler.CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(result.Refused);
        Assert.Equal(CompileRefusal.PluginSourceUnreadable, refused.Refusal);
        Assert.Equal(
            $"{CompileFixture.PluginName}'s plugin source is unreadable, so it cannot be compiled. " +
            "Decompile the plugin to regenerate the source.",
            refused.Message);
        Assert.Equal(before, File.ReadAllBytes(pluginPath));
    }

    [Fact]
    public async Task ASourceFolderThatHoldsNoFiles_IsRefusedBeforeAnyWrite_AsHoldingNoFiles()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var before = File.ReadAllBytes(pluginPath);
        var root = PluginSourceRoot.In(_mod.ModFolder, CompileFixture.PluginName);
        Directory.Delete(root, recursive: true);
        Directory.CreateDirectory(root);

        var result = await _mod.CompileHandler.CompileAsync([_mod.Plugin]);

        Assert.Equal(CompileRefusal.NoSource, Assert.Single(result.Refused).Refusal);
        Assert.Equal(before, File.ReadAllBytes(pluginPath));
    }
}
