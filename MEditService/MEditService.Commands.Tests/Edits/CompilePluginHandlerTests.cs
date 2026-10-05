using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;

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
    public async Task ASourceThatDoesNotParse_IsRefusedByType()
    {
        _mod.Overwrite(_mod.NpcIdentity, "{ not valid json");

        var result = await _mod.CompileHandler.CompileAsync([_mod.Plugin]);

        Assert.Equal(CompileRefusal.SourceDoesNotParse, Assert.Single(result.Refused).Refusal);
    }
}
