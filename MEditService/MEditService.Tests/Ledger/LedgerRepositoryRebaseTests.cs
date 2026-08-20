using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #417 B9: <see cref="LedgerRepository.RebaseEditBranch"/>/<see cref="LedgerRepository.ContinueRebase"/>
/// — refuse-over-dirt, a clean replay, and a conflict resolved by hand whose result still compiles
/// (AC2/AC3).
/// </summary>
public sealed class LedgerRepositoryRebaseTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private string GitDir => Path.Combine(_mod.ModFolder, ".git");
    private string RunGit(params string[] args) => GitCli.Run(GitDir, _mod.ModFolder, args);

    private RecordEditService EditService() =>
        new(_mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    /// <summary>Commits whatever is currently dirty on the edit branch — the ordinary git gesture a
    /// user takes between edits, giving the branch a real commit to rebase.</summary>
    private void CommitOnEditBranch(string message)
    {
        RunGit("add", "-A");
        RunGit("commit", "-q", "-m", message);
    }

    /// <summary>An upstream update that touches NPC's own HeightMax — the same record the edit
    /// branch's own commit below also touches, when both tests want a collision.</summary>
    private void AbsorbUpstreamHeightMaxChange(float newHeightMax)
    {
        var externalMod = new Fallout4Mod(ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = externalMod.Races.AddNew("FixtureRace");
        externalMod.Keywords.AddNew("FixtureKeyword");
        var npc = externalMod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = newHeightMax;
        externalMod.Npcs.AddNew("UntouchedNpc");

        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        externalMod.WriteToBinary(pluginPath);
        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);
    }

    /// <summary>An upstream update that adds a brand-new NPC — a path the edit branch's own commit
    /// never touches, so replaying the two together is conflict-free by construction.</summary>
    private void AbsorbUpstreamNewRecord()
    {
        var externalMod = new Fallout4Mod(ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = externalMod.Races.AddNew("FixtureRace");
        externalMod.Keywords.AddNew("FixtureKeyword");
        var npc = externalMod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        externalMod.Npcs.AddNew("UntouchedNpc");
        externalMod.Npcs.AddNew("BrandNewUpstreamNpc");

        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        externalMod.WriteToBinary(pluginPath);
        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);
    }

    [Fact]
    public void RebaseEditBranch_Refuses_OverUncommittedDirt()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.3"));
        // Never committed — plain working-tree dirt.
        AbsorbUpstreamNewRecord();

        var result = LedgerRepository.RebaseEditBranch(_mod.ModFolder);

        Assert.Equal(RebaseOutcome.Refused, result.Outcome);
        var relative = TrackedModFixture.RelativeLedgerPath(_mod.Npc, "npc_").Replace('\\', '/');
        Assert.Contains(relative, result.RefusalReason, StringComparison.Ordinal);
        // Refused before touching anything: still on edit, still dirty exactly as before.
        Assert.Equal("edit", RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());
        Assert.NotEmpty(_mod.GitStatus());
    }

    [Fact]
    public void RebaseEditBranch_ReplaysCleanly_WhenNothingOverlaps()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.3"));
        CommitOnEditBranch("my own edit");
        AbsorbUpstreamNewRecord();

        var result = LedgerRepository.RebaseEditBranch(_mod.ModFolder);

        Assert.Equal(RebaseOutcome.Clean, result.Outcome);
        Assert.Equal("edit", RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());
        // Both sides survived the replay: my own edit's content, and upstream's new record.
        var relative = TrackedModFixture.RelativeLedgerPath(_mod.Npc, "npc_").Replace('\\', '/');
        Assert.Contains("\"HeightMax\": 0.3", File.ReadAllText(Path.Combine(_mod.ModFolder, relative)), StringComparison.Ordinal);
        var mainSha = RunGit("rev-parse", "refs/heads/main").Trim();
        Assert.Equal(mainSha, RunGit("merge-base", "refs/heads/main", "edit").Trim());
    }

    [Fact]
    public void RebaseEditBranch_Conflicts_OnOverlappingRecordEdits_AndTheResolvedResultCompiles()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.3"));
        CommitOnEditBranch("my own edit");
        AbsorbUpstreamHeightMaxChange(0.7f);

        var conflictResult = LedgerRepository.RebaseEditBranch(_mod.ModFolder);

        var relative = TrackedModFixture.RelativeLedgerPath(_mod.Npc, "npc_").Replace('\\', '/');
        Assert.Equal(RebaseOutcome.Conflicted, conflictResult.Outcome);
        Assert.Contains(relative, conflictResult.ConflictedPaths);
        var conflictedText = File.ReadAllText(Path.Combine(_mod.ModFolder, relative));
        Assert.Contains("<<<<<<<", conflictedText, StringComparison.Ordinal);

        // Hand-resolve exactly the way a user would in the native merge editor — here, taking
        // upstream's side verbatim (still valid, re-parseable ledger text).
        var theirs = RunGit("show", $":3:{relative}");
        File.WriteAllText(Path.Combine(_mod.ModFolder, relative), theirs);

        var continueResult = LedgerRepository.ContinueRebase(_mod.ModFolder);
        Assert.Equal(RebaseOutcome.Clean, continueResult.Outcome);
        Assert.Equal("edit", RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());
        Assert.Empty(LedgerRepository.WorkingTreeStatus(_mod.ModFolder));

        var compileService = new PluginCompileService(_mod.Sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);
        var compileResult = compileService.Compile(_mod.Plugin, new CompileSource.WorkingTree());
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);
    }
}
