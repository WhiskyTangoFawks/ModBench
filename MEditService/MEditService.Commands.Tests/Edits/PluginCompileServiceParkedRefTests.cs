using System.Security.Cryptography;
using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.TestSupport.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Commands.Tests.Edits;

/// <summary>Every compile re-parks the last-compile ref only after the binary write lands,
/// including a compile at a named ref, which touches neither working tree nor HEAD.</summary>
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
        var result = await CompileService().CompileAsync(_mod.Plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var newParked = RunGit("rev-parse", ParkedRef).Trim();
        Assert.NotEqual(baselineParked, newParked);

        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var message = RunGit("show", "-s", "--format=%B", newParked);
        Assert.Contains($"Binary-SHA256: {Sha256Of(pluginPath)}", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_AtMain_AdvancesTheParkedRef_AndTouchesNeitherTheEditBranchsWorkingTreeNorHead()
    {
        _mod.Rewrite<Npc>(_mod.Npc, CompileFixture.NpcRecordType, CompileFixture.NpcEditorId, npc => npc.HeightMax = 0.75f);
        var dirtBefore = _mod.GitStatus();
        var headBefore = RunGit("rev-parse", "HEAD").Trim();
        var branchBefore = RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim();

        var result = await CompileService().CompileAsync(_mod.Plugin, new CompileSource.AtRef("main"));
        Assert.True(result.Succeeded, result.RefusalReason);

        Assert.Equal(dirtBefore, _mod.GitStatus());
        Assert.Equal(headBefore, RunGit("rev-parse", "HEAD").Trim());
        Assert.Equal(branchBefore, RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());

        var pluginPath = Path.Combine(_mod.ModFolder, CompileFixture.PluginName);
        var newParked = RunGit("rev-parse", ParkedRef).Trim();
        var message = RunGit("show", "-s", "--format=%B", newParked);
        Assert.Contains($"Binary-SHA256: {Sha256Of(pluginPath)}", message, StringComparison.Ordinal);
    }

    // Every working-tree document replaced with text the codec cannot read: a compile at main that
    // read one would refuse, so succeeding is the proof it read the ref's blobs instead.
    [Fact]
    public async Task Compile_AtMain_ReadsNoWorkingTreeSourceFile()
    {
        var sourceRoot = Path.Combine(_mod.ModFolder, SourceRepository.RootFor(CompileFixture.PluginName));
        foreach (var file in Directory.EnumerateFiles(sourceRoot, "*.json", SearchOption.AllDirectories))
            File.WriteAllText(file, "{ not valid json");

        var result = await CompileService().CompileAsync(_mod.Plugin, new CompileSource.AtRef("main"));

        Assert.True(result.Succeeded, result.RefusalReason);
        var mod = _mod.Reimport(out var handle);
        using (handle) Assert.Contains(mod.Npcs, n => n.FormKey == _mod.Npc);
    }

    [Fact]
    public async Task Compile_AtARefWhoseTreeCannotBeWritten_LeavesNoScratchDirectoryBehind()
    {
        const string scratchPrefix = "medit-readtree-";
        var sourceRoot = SourceRepository.RootFor(CompileFixture.PluginName);

        // Canary: a directory actually named with this prefix is findable through this exact glob,
        // so the leak check below cannot pass open on a pattern that silently matches nothing.
        var canary = Directory.CreateTempSubdirectory($"{scratchPrefix}canary-").FullName;
        try
        {
            Assert.NotEmpty(Directory.GetDirectories(Path.GetTempPath(), $"{scratchPrefix}*"));
        }
        finally
        {
            Directory.Delete(canary);
        }

        // A file name past NAME_MAX, committed by plumbing onto a ref of its own. No checkout ever
        // happens, so git stores it without complaint and only the materialise step meets the OS.
        var blob = RunGit("hash-object", "-w", "--stdin", "--path", "x.json").Trim();
        var scratchIndex = Path.Combine(Path.GetTempPath(), $"medit-test-index-{Guid.NewGuid():N}");
        try
        {
            GitProbe.RunWithIndex(GitDir, _mod.ModFolder, scratchIndex, "read-tree", "main");
            GitProbe.RunWithIndex(GitDir, _mod.ModFolder, scratchIndex,
                "update-index", "--add", "--cacheinfo", $"100644,{blob},{sourceRoot}/Npcs/{new string('n', 300)}.json");
            var tree = GitProbe.RunWithIndex(GitDir, _mod.ModFolder, scratchIndex, "write-tree").Trim();
            var commit = RunGit("commit-tree", tree, "-p", "main", "-m", "unwritable path").Trim();
            RunGit("update-ref", "refs/heads/unwritable", commit);
        }
        finally
        {
            if (File.Exists(scratchIndex)) File.Delete(scratchIndex);
        }

        // The door materialises the ref's files in a scratch folder of its own, and a write that throws
        // partway through leaves that folder behind unless the cleanup covers the populate.
        var before = Directory.GetDirectories(Path.GetTempPath(), $"{scratchPrefix}*").ToHashSet(StringComparer.Ordinal);

        await Assert.ThrowsAnyAsync<IOException>(
            async () => await CompileService().CompileAsync(_mod.Plugin, new CompileSource.AtRef("unwritable")));

        var after = Directory.GetDirectories(Path.GetTempPath(), $"{scratchPrefix}*").ToHashSet(StringComparer.Ordinal);
        Assert.Empty(after.Except(before, StringComparer.Ordinal));
    }

    [Fact]
    public async Task Compile_ThatRefuses_LeavesTheParkedRefUntouched()
    {
        // Two source files claiming one FormKey (PluginCompileServiceRefusalTests' own scenario) —
        // structurally cannot emit, so nothing about the plugin's parked state should move.
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        var collidingPath = _mod.SourceFileFor(_mod.Npc, "Keyword", CompileFixture.NpcEditorId);
        Directory.CreateDirectory((Path.GetDirectoryName(collidingPath) ?? throw new InvalidOperationException("Expected a parent directory.")));
        File.WriteAllText(collidingPath, npcSourceText);

        var baselineParked = RunGit("rev-parse", ParkedRef).Trim();
        var result = await CompileService().CompileAsync(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Equal(baselineParked, RunGit("rev-parse", ParkedRef).Trim());
    }
}
