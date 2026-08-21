using System.Security.Cryptography;
using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Edits;

/// <summary>
/// #416 S7/S8: every compile re-parks <c>refs/medit/last-compile/&lt;plugin&gt;</c> — the trailer
/// naming the compiled binary's own hash — only after the binary write lands, including a compile at
/// a named ref (<c>AtRef</c>), which touches neither the edit branch's working tree nor its HEAD.
/// </summary>
public sealed class PluginCompileServiceParkedRefTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService EditService() =>
        new(_mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private PluginCompileService CompileService() =>
        new(_mod.Sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string GitDir => Path.Combine(_mod.ModFolder, ".git");
    private static string ParkedRef => $"refs/medit/last-compile/{TrackedModFixture.PluginName}";

    private string RunGit(params string[] args) => GitCli.Run(GitDir, _mod.ModFolder, args);

    private static string Sha256Of(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));

    [Fact]
    public void Compile_WorkingTree_AdvancesTheParkedRef_WithTheCompiledBinarysHash()
    {
        var baselineParked = RunGit("rev-parse", ParkedRef).Trim();

        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var newParked = RunGit("rev-parse", ParkedRef).Trim();
        Assert.NotEqual(baselineParked, newParked);

        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        var message = RunGit("show", "-s", "--format=%B", newParked);
        Assert.Contains($"Binary-SHA256: {Sha256Of(pluginPath)}", message, StringComparison.Ordinal);
    }

    [Fact]
    public void Compile_AtMain_AdvancesTheParkedRef_AndTouchesNeitherTheEditBranchsWorkingTreeNorHead()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));
        var dirtBefore = _mod.GitStatus();
        var headBefore = RunGit("rev-parse", "HEAD").Trim();
        var branchBefore = RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim();

        var result = CompileService().Compile(_mod.Plugin, new CompileSource.AtRef("main"));
        Assert.True(result.Succeeded, result.RefusalReason);

        Assert.Equal(dirtBefore, _mod.GitStatus());
        Assert.Equal(headBefore, RunGit("rev-parse", "HEAD").Trim());
        Assert.Equal(branchBefore, RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());

        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        var newParked = RunGit("rev-parse", ParkedRef).Trim();
        var message = RunGit("show", "-s", "--format=%B", newParked);
        Assert.Contains($"Binary-SHA256: {Sha256Of(pluginPath)}", message, StringComparison.Ordinal);
    }

    [Fact]
    public void Compile_ThatRefuses_LeavesTheParkedRefUntouched()
    {
        // Two source files claiming one FormKey (PluginCompileServiceRefusalTests' own scenario) —
        // structurally cannot emit, so nothing about the plugin's parked state should move.
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        var collidingPath = _mod.SourceFileFor(_mod.Npc, "keyword");
        Directory.CreateDirectory(Path.GetDirectoryName(collidingPath)!);
        File.WriteAllText(collidingPath, npcSourceText);

        var baselineParked = RunGit("rev-parse", ParkedRef).Trim();
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Equal(baselineParked, RunGit("rev-parse", ParkedRef).Trim());
    }
}
