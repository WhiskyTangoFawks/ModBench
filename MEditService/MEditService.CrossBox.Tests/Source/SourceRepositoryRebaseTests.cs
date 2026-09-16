using System.Security.Cryptography;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Source;

public sealed class SourceRepositoryRebaseTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private string GitDir => Path.Combine(_mod.ModFolder, ".git");
    private string RunGit(params string[] args) => GitCli.Run(GitDir, _mod.ModFolder, args);

    private EditRecordHandler EditService() => _mod.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private void CommitOnEditBranch(string message)
    {
        RunGit("add", "-A");
        RunGit("commit", "-q", "-m", message);
    }

    // Bypasses AbsorbExternalChangeHandler deliberately: Absorb now rebases in the same call, and
    // these tests drive SourceRepository.RebaseEditBranch/ContinueRebase directly, one git state at
    // a time, so committing the new baseline stays a step of its own.
    private void CommitUpstreamBinaryAsNewBaseline(IMod externalMod)
    {
        var pluginPath = Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);
        externalMod.WriteToBinary(pluginPath);

        var deepParsed = ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(SourceEditFixture.PluginName), pluginPath),
            _mod.LoadOrder.GameRelease, LocalizedStrings.ForRead(PluginStrings.In(_mod.ModFolder)));
        var pristineFiles = SourceRepository.PristineFilesOf(
            SourceEditFixture.PluginName,
            PluginTrees.SerializeTree(deepParsed).GetAwaiter().GetResult());
        var binarySha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(pluginPath)));
        var trailers = new TrackProvenance(
            null, null, new Dictionary<string, string> { [SourceEditFixture.PluginName] = binarySha256 });

        SourceRepository.CommitPristineToMain(_mod.ModFolder, pristineFiles, trailers);
    }

    private void AbsorbUpstreamHeightMaxChange(float newHeightMax)
    {
        var externalMod = new Fallout4Mod(ModKey.FromFileName(SourceEditFixture.PluginName), Fallout4Release.Fallout4);
        var race = externalMod.Races.AddNew("FixtureRace");
        externalMod.Keywords.AddNew("FixtureKeyword");
        var npc = externalMod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = newHeightMax;
        externalMod.Npcs.AddNew("UntouchedNpc");

        CommitUpstreamBinaryAsNewBaseline(externalMod);
    }

    private void AbsorbUpstreamNewRecord()
    {
        var externalMod = new Fallout4Mod(ModKey.FromFileName(SourceEditFixture.PluginName), Fallout4Release.Fallout4);
        var race = externalMod.Races.AddNew("FixtureRace");
        externalMod.Keywords.AddNew("FixtureKeyword");
        var npc = externalMod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        externalMod.Npcs.AddNew("UntouchedNpc");
        externalMod.Npcs.AddNew("BrandNewUpstreamNpc");

        CommitUpstreamBinaryAsNewBaseline(externalMod);
    }

    [Fact]
    public void RebaseEditBranch_Refuses_OverUncommittedDirt()
    {
        EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.3"));
        // Never committed — plain working-tree dirt.
        AbsorbUpstreamNewRecord();

        var result = SourceRepository.RebaseEditBranch(_mod.ModFolder);

        Assert.Equal(RebaseOutcome.Refused, result.Outcome);
        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId).Replace('\\', '/');
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
        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId).Replace('\\', '/');
        Assert.Contains("\"HeightMax\": 0.3", File.ReadAllText(Path.Combine(_mod.ModFolder, relative)), StringComparison.Ordinal);
        var mainSha = RunGit("rev-parse", "refs/heads/main").Trim();
        Assert.Equal(mainSha, RunGit("merge-base", "refs/heads/main", "edit").Trim());
    }

    [Fact]
    public void RebaseEditBranch_LeavesTheSurvivingEditInTheSourceTree_WhereTheBinaryStillHasUpstreams()
    {
        EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.3"));
        CommitOnEditBranch("my own edit");
        AbsorbUpstreamNewRecord();

        Assert.Equal(RebaseOutcome.Clean, SourceRepository.RebaseEditBranch(_mod.ModFolder).Outcome);

        // The edit survived the replay in the tree; the binary on disk is the one upstream wrote and
        // never carried it, so only the tree can be what a reader of this value reads.
        var npcDocument = _mod.Document(_mod.Npc.ToString())
            ?? throw new InvalidOperationException("Expected the Npc to have a source document after rebase.");
        using var document = JsonDocument.Parse(npcDocument.Body);
        Assert.Equal(0.3f, document.RootElement.GetProperty("HeightMax").GetSingle());

        using var binary = ModFactory.ImportGetter(
            new ModPath(
                ModKey.FromFileName(SourceEditFixture.PluginName),
                Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName)),
            GameRelease.Fallout4);
        Assert.Equal(
            0f, ((IFallout4ModGetter)binary).Npcs.Single(n => n.FormKey == _mod.Npc).HeightMax);
    }

    [Fact]
    public void RebaseEditBranch_Conflicts_OnOverlappingRecordEdits_AndTheResolvedResultCompiles()
    {
        EditService().Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.3"));
        CommitOnEditBranch("my own edit");
        AbsorbUpstreamHeightMaxChange(0.7f);

        var conflictResult = SourceRepository.RebaseEditBranch(_mod.ModFolder);

        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId).Replace('\\', '/');
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

        var compileService = CompileServices.Over(_mod.LoadOrder);
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

        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId).Replace('\\', '/');
        var theirs = RunGit("show", $":3:{relative}");
        File.WriteAllText(Path.Combine(_mod.ModFolder, relative), theirs);

        // The same verb, called again — not ContinueRebase directly.
        var secondResult = SourceRepository.RebaseEditBranch(_mod.ModFolder);

        Assert.Equal(RebaseOutcome.Clean, secondResult.Outcome);
        Assert.Equal("edit", RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());
    }
}
