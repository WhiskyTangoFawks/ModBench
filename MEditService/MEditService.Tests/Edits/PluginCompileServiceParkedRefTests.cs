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

    /// <summary>
    /// A compile at a ref whose tree cannot be written to disk leaves no scratch directory behind.
    ///
    /// <para>An <c>AtRef</c> compile materialises the ref's blobs into a temp directory, because the
    /// whole-mod reader takes a folder rather than a byte stream. Populating that directory is real
    /// I/O against paths this process did not choose, so it can fail — disk full, permissions, a name
    /// the filesystem rejects, or another tool touching the path mid-write (root CLAUDE.md's
    /// never-assume-exclusive-ownership rule). The scratch must go with it.</para>
    ///
    /// <para><b>The window is narrow and easy to get wrong</b>: if the directory is created and
    /// populated before the owning <see cref="IDisposable"/> exists, a throw during population happens
    /// before <c>using</c> has anything to bind, so <c>Dispose</c> never runs and the directory leaks
    /// permanently. Every compile against that ref then leaks another. The fix is to construct the
    /// owner first and dispose it on the way out of a failed populate; this is the test that says so.</para>
    ///
    /// <para>An over-long file name is the trigger because it is reachable through git alone — the ref
    /// is built with plumbing, never checked out, so git happily stores a path the filesystem will
    /// refuse. Asserting the throw as well as the cleanup keeps the test honest: on a filesystem that
    /// accepted the name, it fails loudly rather than passing vacuously.</para>
    /// </summary>
    [Fact]
    public void Compile_AtARefWhoseTreeCannotBeWritten_LeavesNoScratchDirectoryBehind()
    {
        const string scratchPrefix = "medit-compile-ref-";
        var sourceRoot = SourceRecordPath.RootFor(TrackedModFixture.PluginName);

        // A file name past NAME_MAX, committed by plumbing onto a ref of its own. No checkout ever
        // happens, so git stores it without complaint and only the materialise step meets the OS.
        var blob = RunGit("hash-object", "-w", "--stdin", "--path", "x.json").Trim();
        var scratchIndex = Path.Combine(Path.GetTempPath(), $"medit-test-index-{Guid.NewGuid():N}");
        try
        {
            GitCli.RunWithIndex(GitDir, _mod.ModFolder, scratchIndex, "read-tree", "main");
            GitCli.RunWithIndex(GitDir, _mod.ModFolder, scratchIndex,
                "update-index", "--add", "--cacheinfo", $"100644,{blob},{sourceRoot}/Npcs/{new string('n', 300)}.json");
            var tree = GitCli.RunWithIndex(GitDir, _mod.ModFolder, scratchIndex, "write-tree").Trim();
            var commit = RunGit("commit-tree", tree, "-p", "main", "-m", "unwritable path").Trim();
            RunGit("update-ref", "refs/heads/unwritable", commit);
        }
        finally
        {
            if (File.Exists(scratchIndex)) File.Delete(scratchIndex);
        }

        var before = Directory.GetDirectories(Path.GetTempPath(), $"{scratchPrefix}*").ToHashSet(StringComparer.Ordinal);

        Assert.ThrowsAny<IOException>(
            () => CompileService().Compile(_mod.Plugin, new CompileSource.AtRef("unwritable")));

        var after = Directory.GetDirectories(Path.GetTempPath(), $"{scratchPrefix}*").ToHashSet(StringComparer.Ordinal);
        Assert.Empty(after.Except(before, StringComparer.Ordinal));
    }

    [Fact]
    public void Compile_ThatRefuses_LeavesTheParkedRefUntouched()
    {
        // Two source files claiming one FormKey (PluginCompileServiceRefusalTests' own scenario) —
        // structurally cannot emit, so nothing about the plugin's parked state should move.
        var npcSourceText = File.ReadAllText(_mod.NpcSourceFile);
        var collidingPath = _mod.SourceFileFor(_mod.Npc, "keyword", TrackedModFixture.NpcEditorId);
        Directory.CreateDirectory(Path.GetDirectoryName(collidingPath)!);
        File.WriteAllText(collidingPath, npcSourceText);

        var baselineParked = RunGit("rev-parse", ParkedRef).Trim();
        var result = CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Equal(baselineParked, RunGit("rev-parse", ParkedRef).Trim());
    }
}
