using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>
/// #417 B8 (Absorb Upstream Update): a real xEdit-style external binary change lands as a new
/// pristine baseline on <c>main</c>, by plumbing, with the edit branch left exactly as it was.
/// </summary>
public sealed class ExternalChangeAbsorberTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    /// <summary>An external tool's in-place save: the same FormKeys as the fixture's own plugin
    /// (built the same way <c>LoadOrderMirrorTests.WriteCopy</c> establishes agreement),
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

    /// <summary>
    /// Absorb's baseline is a <b>complete</b> source tree, not just the record files — the invariant
    /// that had quietly lapsed since #451 and that #454 turned into a crash.
    ///
    /// <para>Absorb rebuilds the whole tree and <c>CommitPristineToMain</c> writes only what it is
    /// handed, with no merge against the previous tree, so anything Absorb forgets is <i>deleted</i>
    /// from the baseline. It used to be built one record at a time and so forgot the one non-record
    /// file: the root <c>RecordData.json</c> that is the mod header's own source file (ADR-0041's #444
    /// amendment, point 1). A tree with no root document cannot be read back
    /// at all — the whole-mod door's <c>ExtractMeta</c> takes ModKey and GameRelease from it — which
    /// breaks compile <i>and</i> ingest-from-source the moment that baseline reaches a working tree.</para>
    ///
    /// <para>Fixed at the root by sharing Track's own serialization
    /// (<c>TrackService.SerializeToPristineFiles</c>) instead of hand-rolling a second one. This
    /// asserts the property directly, so the next hand-rolled tree writer fails here rather than three
    /// operations downstream.</para>
    /// </summary>
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
        Assert.DoesNotContain($"{root}/spriggit-meta.json", tree);
        Assert.DoesNotContain($"{root}/.spriggit", tree);
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
