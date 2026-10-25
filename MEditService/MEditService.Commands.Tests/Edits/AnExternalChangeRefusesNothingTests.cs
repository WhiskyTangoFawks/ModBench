using MEditService.Commands.Tests.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class AnExternalChangeRefusesNothingTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public async Task Compile_OverAnotherToolsBytes_ReplacesThemWithThePluginItsSourceHolds()
    {
        File.WriteAllBytes(Path.Combine(_mod.ModFolder, CompileFixture.PluginName), "changed-by-xedit"u8.ToArray());

        using var compiled = await _mod.CompiledAsync(_mod.Plugin);

        Assert.Equal(CompileFixture.NpcEditorId, compiled.Npcs.Single(npc => npc.FormKey == _mod.Npc).EditorID);
    }
}
