using System.Security.Cryptography;
using MEditService.Commands.Edits;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Every compile re-parks the last-compile ref only after the binary write lands.</summary>
public sealed class PluginCompileServiceParkedRefTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    private PluginCompileService CompileService() =>
        _mod.CompileService();

    private string GitDir => Path.Combine(_mod.ModFolder, ".git");
    private static string ParkedRef => $"refs/medit/last-compile/{CompileFixture.PluginName}";

    private string RunGit(params string[] args) => GitProbe.Run(GitDir, _mod.ModFolder, args);

    private static string Sha256Of(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    [Fact]
    public async Task Compile_WorkingTree_AdvancesTheParkedRef_WithTheCompiledBinarysHash()
    {
        var baselineParked = RunGit("rev-parse", ParkedRef).Trim();

        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        var result = await CompileService().CompileAsync(_mod.Plugin);
        Assert.True(result.Succeeded, result.RefusalReason);

        var newParked = RunGit("rev-parse", ParkedRef).Trim();
        Assert.NotEqual(baselineParked, newParked);

        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var message = RunGit("show", "-s", "--format=%B", newParked);
        Assert.Contains($"Binary-SHA256: {Sha256Of(pluginPath)}", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_ThatRefuses_LeavesTheParkedRefUntouched()
    {
        // Two source files claiming one FormKey (PluginCompileServiceRefusalTests' own scenario) —
        // structurally cannot emit, so nothing about the plugin's parked state should move.
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        var collidingPath = _mod.SourceFileFor(_mod.Npc, "Keyword", CompileFixture.NpcEditorId);
        Directory.CreateDirectory(Path.GetDirectoryName(collidingPath) ?? throw new InvalidOperationException($"Expected '{collidingPath}' to have a parent directory."));
        File.WriteAllText(collidingPath, npcSourceText);

        var baselineParked = RunGit("rev-parse", ParkedRef).Trim();
        var result = await CompileService().CompileAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Equal(baselineParked, RunGit("rev-parse", ParkedRef).Trim());
    }
}
