using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

public sealed class ExternalChangeAbsorberTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private void WriteExternalBinaryChange(float newHeightMax)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("FixtureRace");
        mod.Keywords.AddNew("FixtureKeyword");
        var npc = mod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = newHeightMax;
        mod.Npcs.AddNew("UntouchedNpc");

        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        mod.WriteToBinary(pluginPath);
    }

    [Fact]
    public void Absorb_CommitsTheExternalBinarysContent_AsANewBaselineOnMain()
    {
        WriteExternalBinaryChange(0.9f);
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);

        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, _mod.Mirror.LoadOrder!);

        var relativePath = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var newBaseline = GitCli.Run(gitDir, _mod.ModFolder, "show", $"main:{relativePath}");
        Assert.Contains("\"HeightMax\": 0.9", newBaseline, StringComparison.Ordinal);
    }

    [Fact]
    public void Absorb_TouchesNeitherTheEditBranchsWorkingTreeNorItsHead()
    {
        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var branchBefore = GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "--abbrev-ref", "HEAD").Trim();
        var headBefore = GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "HEAD").Trim();
        var dirtBefore = _mod.GitStatus();

        WriteExternalBinaryChange(0.9f);
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);
        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, _mod.Mirror.LoadOrder!);

        Assert.Equal(branchBefore, GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "--abbrev-ref", "HEAD").Trim());
        Assert.Equal(headBefore, GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "HEAD").Trim());
        Assert.Equal(dirtBefore, _mod.GitStatus());
    }

    [Fact]
    public void Absorb_ClearsAnyUnansweredDeferralForThePlugin()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "unanswered");
        WriteExternalBinaryChange(0.9f);
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);

        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, _mod.Mirror.LoadOrder!);

        Assert.Null(ExternalChangeDeferral.Unanswered(_mod.ModFolder, TrackedModFixture.PluginName));
    }

    // Absorb shares Track's own serializer rather than a per-record tree writer, because the pristine
    // commit writes only what it is handed with no merge: anything forgotten leaves the baseline.
    [Fact]
    public void Absorb_WritesACompleteSourceTree_IncludingTheModHeader()
    {
        WriteExternalBinaryChange(0.9f);
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);

        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, _mod.Mirror.LoadOrder!);

        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var tree = GitCli.Run(gitDir, _mod.ModFolder, "ls-tree", "-r", "--name-only", "main")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .ToList();

        var root = SourceRecordPath.RootFor(TrackedModFixture.PluginName).Replace('\\', '/');
        Assert.Contains($"{root}/RecordData.json", tree);
    }

    [Fact]
    public void Absorb_AdvancesTheParkedRefToTheNewBaseline()
    {
        WriteExternalBinaryChange(0.9f);
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);

        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, _mod.Mirror.LoadOrder!);

        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var mainSha = GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "refs/heads/main").Trim();
        var parkedSha = GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", $"refs/medit/last-compile/{TrackedModFixture.PluginName}").Trim();
        Assert.Equal(mainSha, parkedSha);
    }
}
