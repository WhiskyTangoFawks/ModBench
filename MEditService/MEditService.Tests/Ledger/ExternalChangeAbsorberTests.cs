using MEditService.Core.Ledger;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #417 B8 (Absorb Upstream Update): a real xEdit-style external binary change lands as a new
/// pristine baseline on <c>main</c>, by plumbing, with the edit branch left exactly as it was.
/// </summary>
public sealed class ExternalChangeAbsorberTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    /// <summary>An external tool's in-place save: the same FormKeys as the fixture's own plugin
    /// (built the same way <c>SessionManagerRereadPluginTests.WriteCopy</c> establishes agreement),
    /// one field changed — exactly what xEdit does when a user tweaks a value and saves.</summary>
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

        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        var relativePath = TrackedModFixture.RelativeLedgerPath(_mod.Npc, "npc_").Replace('\\', '/');
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
        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        Assert.Equal(branchBefore, GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "--abbrev-ref", "HEAD").Trim());
        Assert.Equal(headBefore, GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "HEAD").Trim());
        Assert.Equal(dirtBefore, _mod.GitStatus());
    }

    [Fact]
    public void Absorb_ClearsAnyPendingDeferralForThePlugin()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "pending");
        WriteExternalBinaryChange(0.9f);
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);

        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        Assert.Null(ExternalChangeDeferral.Pending(_mod.ModFolder, TrackedModFixture.PluginName));
    }

    [Fact]
    public void Absorb_AdvancesTheParkedRefToTheNewBaseline()
    {
        WriteExternalBinaryChange(0.9f);
        var pluginPath = Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);

        ExternalChangeAbsorber.Absorb(_mod.ModFolder, TrackedModFixture.PluginName, pluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var mainSha = GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", "refs/heads/main").Trim();
        var parkedSha = GitCli.Run(gitDir, _mod.ModFolder, "rev-parse", $"refs/medit/last-compile/{TrackedModFixture.PluginName}").Trim();
        Assert.Equal(mainSha, parkedSha);
    }
}
