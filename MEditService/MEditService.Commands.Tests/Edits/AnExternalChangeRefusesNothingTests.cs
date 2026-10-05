using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class AnExternalChangeRefusesNothingTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private string PluginPath => Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);

    [Fact]
    public void AnEdit_Lands()
    {
        _mod.ChangeOutsideModbench();

        var result = _mod.EditHandler.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void ACreate_Lands()
    {
        _mod.ChangeOutsideModbench();

        var result = _mod.CreateHandler.CreateRecord(_mod.Plugin, "npc_", "New");

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void ADelete_Lands()
    {
        _mod.ChangeOutsideModbench();
        var npc = new RecordAt(_mod.Plugin, _mod.Npc.ToString());

        var result = _mod.DeleteHandler.DeleteRecords([npc]);

        Assert.Empty(result.Refused);
        Assert.Equal([npc], result.Landed.Select(landed => landed.Item));
    }

    [Fact]
    public async Task ACompile_Lands_OverTheOtherToolsBytes()
    {
        _mod.ChangeOutsideModbench();
        var theirs = File.ReadAllBytes(PluginPath);

        var result = await _mod.CompileHandler.CompileAsync([_mod.Plugin]);

        Assert.Empty(result.Refused);
        Assert.NotEqual(theirs, File.ReadAllBytes(PluginPath));
    }
}
