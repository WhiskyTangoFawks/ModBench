using System.Security.Cryptography;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginParkedRefTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private CompilePluginHandler CompileService() =>
        _mod.CompileService();

    private IReadOnlyList<string> Parked() => LastWriteRecord.Of(_mod.ModFolder, CompileFixture.PluginName);

    private static string Sha256Of(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    [Fact]
    public async Task Compile_WorkingTree_AdvancesTheParkedRef_WithTheCompiledBinarysHash()
    {
        var baselineParked = Parked();

        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        var result = await CompileService().CompileOneAsync(_mod.Plugin);
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        Assert.Equal([Sha256Of(pluginPath)], Parked());
        Assert.NotEqual(baselineParked, Parked());
    }

    [Fact]
    public async Task Compile_ThatRefuses_LeavesTheParkedRefUntouched()
    {
        TreeTampering.Duplicate(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);

        var baselineParked = Parked();
        var result = await CompileService().CompileOneAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Equal(baselineParked, Parked());
    }

    [Fact]
    public async Task Compile_ThatCannotFinishItsRecord_Lands_AndSaysSo()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var before = File.ReadAllBytes(pluginPath);
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        LastWriteRecord.RefuseRefUpdatesAfterTheFirst(_mod.ModFolder);

        var result = await CompileService().CompileOneAsync(_mod.Plugin);

        Assert.True(result.Succeeded, result.RefusalReason);
        Assert.NotEqual(before, File.ReadAllBytes(pluginPath));
        Assert.Single(result.Diagnostics, d => d.Message.Contains("could not be finished", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Compile_ThatCannotParkItsRecord_IsRefusedAsAFailedWrite_AndLeavesTheOldBinary()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var before = File.ReadAllBytes(pluginPath);
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        var refLock = LastWriteRecord.LockFileOfTheOnlyPlugin(_mod.ModFolder);
        File.WriteAllText(refLock, "");
        try
        {
            var result = await CompileService().CompileOneAsync(_mod.Plugin);

            Assert.Equal(CompileRefusal.WriteFailed, result.Refusal);
            Assert.DoesNotContain(_mod.ModFolder, result.RefusalReason, StringComparison.Ordinal);
        }
        finally
        {
            File.Delete(refLock);
        }

        Assert.Equal(before, File.ReadAllBytes(pluginPath));
    }
}
