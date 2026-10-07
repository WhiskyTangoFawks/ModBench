using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompileRecordingTheLastWriteTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private CompilePluginHandler CompileService() =>
        _mod.CompileService();

    [Fact]
    public async Task Compile_WorkingTree_LeavesTheCompiledBinaryAsTheOneModbenchLastWrote()
    {
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        var answer = await CompileService().CompileAsync([_mod.Plugin]);
        Assert.Empty(answer.Refused);
        Assert.Single(answer.Landed);

        Assert.Empty(ExternalChanges.NamedBy(_mod.LoadOrder));
    }

    [Fact]
    public async Task Compile_ThatRefuses_LeavesTheBinaryAsTheOneModbenchLastWrote()
    {
        TreeTampering.Duplicate(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        Assert.Single(answer.Refused);
        Assert.Empty(ExternalChanges.NamedBy(_mod.LoadOrder));
    }

    [Fact]
    public async Task Compile_ThatCannotFinishItsRecord_Lands_AndSaysSo()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var before = File.ReadAllBytes(pluginPath);
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        LastWriteRecord.RefuseRefUpdatesAfterTheFirst(_mod.ModFolder);

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        Assert.Empty(answer.Refused);
        var diagnostics = Assert.Single(answer.Landed).Outcome;
        Assert.NotEqual(before, File.ReadAllBytes(pluginPath));
        Assert.Single(diagnostics, d => d.Message.Contains("could not be finished", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Compile_ThatCannotParkItsRecord_IsRefusedAsAFailedWrite_AndLeavesTheOldBinary()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var before = File.ReadAllBytes(pluginPath);
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        LastWriteRecord.RefuseRefUpdates(_mod.ModFolder);

        var answer = await CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Equal(CompileRefusal.WriteFailed, refused.Refusal);
        Assert.DoesNotContain(_mod.ModFolder, refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, File.ReadAllBytes(pluginPath));
    }
}
