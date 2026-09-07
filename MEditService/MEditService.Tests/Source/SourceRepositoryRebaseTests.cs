using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

public sealed class SourceRepositoryRebaseTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private string GitDir => Path.Combine(_mod.ModFolder, ".git");
    private string RunGit(params string[] args) => GitCli.Run(GitDir, _mod.ModFolder, args);

    private ProjectingEditService EditService() =>
        ProjectingEditService.Over(_mod.Mirror);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private void CommitOnEditBranch(string message)
    {
        RunGit("add", "-A");
        RunGit("commit", "-q", "-m", message);
    }

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
        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, _mod.Mirror.LoadOrder!);
    }

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
        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, _mod.Mirror.LoadOrder!);
    }

    [Fact]
    public void RebaseEditBranch_Refuses_OverUncommittedDirt()
    {
        EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.3"));
        // Never committed — plain working-tree dirt.
        AbsorbUpstreamNewRecord();

        var result = SourceRepository.RebaseEditBranch(_mod.ModFolder);

        Assert.Equal(RebaseOutcome.Refused, result.Outcome);
        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        Assert.Contains(relative, result.RefusalReason, StringComparison.Ordinal);
        // Refused before touching anything: still on edit, still dirty exactly as before.
        Assert.Equal("edit", RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());
        Assert.NotEmpty(_mod.GitStatus());
    }

    [Fact]
    public void RebaseEditBranch_ReplaysCleanly_WhenNothingOverlaps()
    {
        EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.3"));
        CommitOnEditBranch("my own edit");
        AbsorbUpstreamNewRecord();

        var result = SourceRepository.RebaseEditBranch(_mod.ModFolder);

        Assert.Equal(RebaseOutcome.Clean, result.Outcome);
        Assert.Equal("edit", RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());
        // Both sides survived the replay: my own edit's content, and upstream's new record.
        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        Assert.Contains("\"HeightMax\": 0.3", File.ReadAllText(Path.Combine(_mod.ModFolder, relative)), StringComparison.Ordinal);
        var mainSha = RunGit("rev-parse", "refs/heads/main").Trim();
        Assert.Equal(mainSha, RunGit("merge-base", "refs/heads/main", "edit").Trim());
    }

    [Fact]
    public void RebaseEditBranch_ThenAReload_StillIngestsThePluginFromItsSourceTree()
    {
        EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.3"));
        CommitOnEditBranch("my own edit");
        AbsorbUpstreamNewRecord();

        Assert.Equal(RebaseOutcome.Clean, SourceRepository.RebaseEditBranch(_mod.ModFolder).Outcome);

        using var reloaded = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)reloaded).Reconcile(
            _mod.GameDirectory,
            [new LoadOrderEntry(TrackedModFixture.PluginName, Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName), TrackedModFixture.ModFolderOrigin, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        // No degraded load, and the record reads with the edit that survived the replay — which it can
        // only do if the source tree was read, since the binary on disk is upstream's and has 1.0.
        Assert.Empty(reloaded.Status.Failures);
        Assert.Equal(0.3f, Assert.IsType<JsonElement>(reloaded.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Fields
            .Single(f => f.Metadata.Name == "HeightMax").Value).GetSingle());
    }

    [Fact]
    public void RebaseEditBranch_Conflicts_OnOverlappingRecordEdits_AndTheResolvedResultCompiles()
    {
        EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.3"));
        CommitOnEditBranch("my own edit");
        AbsorbUpstreamHeightMaxChange(0.7f);

        var conflictResult = SourceRepository.RebaseEditBranch(_mod.ModFolder);

        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        Assert.Equal(RebaseOutcome.Conflicted, conflictResult.Outcome);
        Assert.Contains(relative, conflictResult.ConflictedPaths);
        var conflictedText = File.ReadAllText(Path.Combine(_mod.ModFolder, relative));
        Assert.Contains("<<<<<<<", conflictedText, StringComparison.Ordinal);

        // Hand-resolve exactly the way a user would in the native merge editor — here, taking
        // upstream's side verbatim (still valid, re-parseable source text).
        var theirs = RunGit("show", $":3:{relative}");
        File.WriteAllText(Path.Combine(_mod.ModFolder, relative), theirs);

        var continueResult = SourceRepository.ContinueRebase(_mod.ModFolder);
        Assert.Equal(RebaseOutcome.Clean, continueResult.Outcome);
        Assert.Equal("edit", RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());
        Assert.Empty(SourceRepository.WorkingTreeStatus(_mod.ModFolder));

        var compileService = new PluginCompileService(_mod.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);
        var compileResult = compileService.Compile(_mod.Plugin, new CompileSource.WorkingTree());
        Assert.True(compileResult.Succeeded, compileResult.RefusalReason);
    }

    [Fact]
    public void RebaseEditBranch_CalledAgainAfterAConflictIsResolved_ResumesRatherThanRefusing()
    {
        EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.3"));
        CommitOnEditBranch("my own edit");
        AbsorbUpstreamHeightMaxChange(0.7f);

        var conflictResult = SourceRepository.RebaseEditBranch(_mod.ModFolder);
        Assert.Equal(RebaseOutcome.Conflicted, conflictResult.Outcome);

        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        var theirs = RunGit("show", $":3:{relative}");
        File.WriteAllText(Path.Combine(_mod.ModFolder, relative), theirs);

        // The same verb, called again — not ContinueRebase directly.
        var secondResult = SourceRepository.RebaseEditBranch(_mod.ModFolder);

        Assert.Equal(RebaseOutcome.Clean, secondResult.Outcome);
        Assert.Equal("edit", RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());
    }
}
