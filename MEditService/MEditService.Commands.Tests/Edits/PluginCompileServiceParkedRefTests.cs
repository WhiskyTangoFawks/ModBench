using System.Security.Cryptography;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

public sealed class PluginCompileServiceParkedRefTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private PluginCompileService CompileService() =>
        _mod.CompileService();

    private string GitDir => Path.Combine(_mod.ModFolder, ".git");
    private IReadOnlyList<string> Parked() => SourceRepository.ParkedCompileBinarySha256s(_mod.ModFolder, CompileFixture.PluginName);

    private static string Sha256Of(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    [Fact]
    public async Task Compile_WorkingTree_AdvancesTheParkedRef_WithTheCompiledBinarysHash()
    {
        var baselineParked = Parked();

        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        var result = await CompileService().CompileAsync(_mod.Plugin);
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
        var result = await CompileService().CompileAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Equal(baselineParked, Parked());
    }

    [Fact]
    public async Task Compile_ThatCannotParkItsRecord_LeavesTheOldBinary()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var before = File.ReadAllBytes(pluginPath);
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        var refLock = Path.Combine(GitDir, SourceRepository.LastCompileRef(CompileFixture.PluginName) + ".lock");
        File.WriteAllText(refLock, "");
        try
        {
            await Assert.ThrowsAnyAsync<InvalidOperationException>(() => CompileService().CompileAsync(_mod.Plugin));
        }
        finally
        {
            File.Delete(refLock);
        }

        Assert.Equal(before, File.ReadAllBytes(pluginPath));
    }
}
