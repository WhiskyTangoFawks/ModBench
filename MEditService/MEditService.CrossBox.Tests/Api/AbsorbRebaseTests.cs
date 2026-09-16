using MEditService.Http.Endpoints;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using MEditService.Watcher;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>Absorb over the real HTTP mapping and a real git repo: the endpoint commits the new
/// baseline, then rebases the edit branch onto it in the same call — no separate offer.</summary>
public sealed class AbsorbRebaseTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private string GitDir => System.IO.Path.Combine(_mod.ModFolder, ".git");
    private string RunGit(params string[] args) => GitCli.Run(GitDir, _mod.ModFolder, args);
    private string RelativeNpcPath => _mod.RelativeSourcePath(_mod.Npc, "npc_", IndexedModFixture.NpcEditorId).Replace('\\', '/');

    private void CommitOnEditBranch(string message)
    {
        RunGit("add", "-A");
        RunGit("commit", "-q", "-m", message);
    }

    // Upstream's release: always a brand-new record, plus the NPC's HeightMax when the scenario
    // needs an overlap with the local edit under test.
    private void WriteExternalRelease(float? npcHeightMax = null)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(IndexedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew(IndexedModFixture.RaceEditorId);
        mod.Keywords.AddNew(IndexedModFixture.KeywordEditorId);
        var npc = mod.Npcs.AddNew(IndexedModFixture.NpcEditorId);
        npc.Race.SetTo(race);
        if (npcHeightMax is { } heightMax) npc.HeightMax = heightMax;
        mod.Npcs.AddNew(IndexedModFixture.OtherNpcEditorId);
        mod.Npcs.AddNew("BrandNewUpstreamNpc");
        mod.WriteToBinary(System.IO.Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName));
    }

    private static (ILoggerFactory factory, ModFolderWatcher watcher) Backend() =>
        (LoggerFactory.Create(_ => { }), TestWatcher.Inert());

    private Ok<ExternalChangeActionResponse> Absorb()
    {
        var (loggerFactory, watcher) = Backend();
        using var _dispose = loggerFactory;
        var result = PluginEndpoints.AbsorbExternalChange(
            new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin),
            _mod.Holder, TestEditService.AbsorbHandler(), watcher, loggerFactory);
        return Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(result);
    }

    [Fact]
    public void CleanEditBranch_IsRebasedOntoTheNewBaseline()
    {
        TestEditService.EditHandler(_mod.Holder).Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.3"));
        CommitOnEditBranch("my own edit");
        WriteExternalRelease();

        var ok = Absorb();
        var response = ok.Value;
        Assert.NotNull(response);

        Assert.True(response.Succeeded);
        Assert.Equal(RebaseOutcome.Clean, response.Rebase?.Outcome);
        Assert.Equal("edit", RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());
        var mainSha = RunGit("rev-parse", "refs/heads/main").Trim();
        Assert.Equal(mainSha, RunGit("merge-base", "refs/heads/main", "edit").Trim());
        // Both sides survived the replay: my own edit's content, and upstream's new record.
        Assert.Contains(
            "\"HeightMax\": 0.3", File.ReadAllText(System.IO.Path.Combine(_mod.ModFolder, RelativeNpcPath)), StringComparison.Ordinal);
    }

    [Fact]
    public void UncommittedDirt_CommitsTheBaselineButRefusesTheRebase_LeavingTheBranchUntouched()
    {
        TestEditService.EditHandler(_mod.Holder).Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.3"));
        // Never committed — plain working-tree dirt.
        var headBefore = RunGit("rev-parse", "HEAD").Trim();
        var mainBefore = RunGit("rev-parse", "refs/heads/main").Trim();
        WriteExternalRelease();

        var ok = Absorb();
        var response = ok.Value;
        Assert.NotNull(response);

        Assert.True(response.Succeeded, "the baseline commit lands even when the rebase that follows refuses");
        var rebase = response.Rebase;
        Assert.NotNull(rebase);
        Assert.Equal(RebaseOutcome.Refused, rebase.Outcome);
        Assert.Contains(RelativeNpcPath, rebase.RefusalReason, StringComparison.Ordinal);
        Assert.Equal("edit", RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());
        Assert.Equal(headBefore, RunGit("rev-parse", "HEAD").Trim());
        Assert.NotEqual(mainBefore, RunGit("rev-parse", "refs/heads/main").Trim());
    }

    [Fact]
    public void ConflictingEdit_ReturnsConflictedWithThePaths_LeavingAbsorbSucceeded()
    {
        TestEditService.EditHandler(_mod.Holder).Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.3"));
        CommitOnEditBranch("my own edit");
        WriteExternalRelease(npcHeightMax: 0.7f);

        var ok = Absorb();
        var response = ok.Value;
        Assert.NotNull(response);

        Assert.True(response.Succeeded);
        var rebase = response.Rebase;
        Assert.NotNull(rebase);
        Assert.Equal(RebaseOutcome.Conflicted, rebase.Outcome);
        Assert.Contains(RelativeNpcPath, rebase.ConflictedPaths);
        var conflictedText = File.ReadAllText(System.IO.Path.Combine(_mod.ModFolder, RelativeNpcPath));
        Assert.Contains("<<<<<<<", conflictedText, StringComparison.Ordinal);
    }

    private static System.Text.Json.JsonElement Json(string raw) => System.Text.Json.JsonDocument.Parse(raw).RootElement;
}
