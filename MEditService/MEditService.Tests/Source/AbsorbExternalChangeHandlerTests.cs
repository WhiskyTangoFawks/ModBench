using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

public sealed class AbsorbExternalChangeHandlerTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private void WriteExternalBinaryChange(float newHeightMax)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(SourceEditFixture.PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("FixtureRace");
        mod.Keywords.AddNew("FixtureKeyword");
        var npc = mod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = newHeightMax;
        mod.Npcs.AddNew("UntouchedNpc");

        var pluginPath = Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);
        mod.WriteToBinary(pluginPath);
    }

    [Fact]
    public void Absorb_CommitsTheExternalBinarysContent_AsANewBaselineOnMain()
    {
        WriteExternalBinaryChange(0.9f);
        var pluginPath = Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);

        var result = _mod.AbsorbHandler.Absorb(_mod.ModFolder, _mod.PluginCopies(pluginPath), _mod.LoadOrder);

        Assert.True(result.Applied, result.RefusalReason);
        var relativePath = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId).Replace('\\', '/');
        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var newBaseline = GitCli.Run(gitDir, _mod.ModFolder, "show", $"main:{relativePath}");
        Assert.Contains("\"HeightMax\": 0.9", newBaseline, StringComparison.Ordinal);
    }

    // Absorb rebases the edit branch onto its new baseline in the same call; over a clean branch
    // that never diverged, the rebase is a fast-forward, so HEAD lands exactly on main's new tip.
    [Fact]
    public void Absorb_FastForwardsTheCleanEditBranchOntoTheNewBaseline()
    {
        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var dirtBefore = _mod.GitStatus();
        WriteExternalBinaryChange(0.9f);
        var pluginPath = Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);

        var result = _mod.AbsorbHandler.Absorb(_mod.ModFolder, _mod.PluginCopies(pluginPath), _mod.LoadOrder);

        Assert.True(result.Applied, result.RefusalReason);
        Assert.Equal(RebaseOutcome.Clean, result.Rebase?.Outcome);
        var mainSha = GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "refs/heads/main").Trim();
        Assert.Equal("edit", GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "--abbrev-ref", "HEAD").Trim());
        Assert.Equal(mainSha, GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "HEAD").Trim());
        // Only the ignored plugin binary shows, same as before Absorb ran — nothing git tracks is dirty.
        Assert.Equal(dirtBefore, _mod.GitStatus());
    }

    [Fact]
    public void Absorb_ClearsTheModsUnansweredDeferral()
    {
        SourceRepository.RaiseExternalChangeQuestion(_mod.ModFolder, "unanswered");
        WriteExternalBinaryChange(0.9f);
        var pluginPath = Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);

        _mod.AbsorbHandler.Absorb(_mod.ModFolder, _mod.PluginCopies(pluginPath), _mod.LoadOrder);

        Assert.Null(SourceRepository.UnansweredExternalChange(_mod.ModFolder));
    }

    // Absorb shares Track's own serializer rather than a per-record tree writer, because the pristine
    // commit writes only what it is handed with no merge: anything forgotten leaves the baseline.
    [Fact]
    public void Absorb_WritesACompleteSourceTree_IncludingTheModHeader()
    {
        WriteExternalBinaryChange(0.9f);
        var pluginPath = Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);

        _mod.AbsorbHandler.Absorb(_mod.ModFolder, _mod.PluginCopies(pluginPath), _mod.LoadOrder);

        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var tree = GitCli.Run(gitDir, _mod.ModFolder, "ls-tree", "-r", "--name-only", "main")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .ToList();

        var root = SourceRepository.RootFor(SourceEditFixture.PluginName).Replace('\\', '/');
        Assert.Contains($"{root}/RecordData.json", tree);
    }

    // A binary Mutagen cannot read is the user's answer to a question they can still answer the
    // other way, so it comes back as a refusal and leaves main where it was.
    [Fact]
    public void Absorb_WithABinaryThatCannotBeParsed_RefusesNamingThePluginAndLeavesMainAlone()
    {
        var pluginPath = Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);
        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var mainBefore = GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "refs/heads/main").Trim();
        File.WriteAllBytes(pluginPath, [0x00, 0x01, 0x02, 0x03]);

        var result = _mod.AbsorbHandler.Absorb(_mod.ModFolder, _mod.PluginCopies(pluginPath), _mod.LoadOrder);

        Assert.False(result.Applied);
        Assert.Contains(SourceEditFixture.PluginName, result.RefusalReason, StringComparison.Ordinal);
        Assert.Equal(mainBefore, GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "refs/heads/main").Trim());
    }

    [Fact]
    public void Absorb_AdvancesTheParkedRefToTheNewBaseline()
    {
        WriteExternalBinaryChange(0.9f);
        var pluginPath = Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);

        _mod.AbsorbHandler.Absorb(_mod.ModFolder, _mod.PluginCopies(pluginPath), _mod.LoadOrder);

        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var mainSha = GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "refs/heads/main").Trim();
        var parkedSha = GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", $"refs/medit/last-compile/{SourceEditFixture.PluginName}").Trim();
        Assert.Equal(mainSha, parkedSha);
    }
}
