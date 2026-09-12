using MEditService.Api.Endpoints;
using MEditService.Bridge;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>Everything preset: the answers cover every changed tracked file, not just the plugin
/// (ADR-0003) — asserted through the HTTP API against a real git repo.</summary>
public sealed class AbsorbKeepTrackedFileTests : IDisposable
{
    private const string AssetRelativePath = "Meshes/Thing.nif";
    private const string DeletedAssetRelativePath = "Meshes/Gone.nif";

    private IndexedModFixture _mod = null!;

    public void Dispose() => _mod.Dispose();

    private void TrackWithAssets()
    {
        _mod = IndexedModFixture.TrackedEverything(modFolder =>
        {
            Directory.CreateDirectory(Path.Combine(modFolder, "Meshes"));
            File.WriteAllBytes(Path.Combine(modFolder, AssetRelativePath), "original-mesh"u8.ToArray());
            File.WriteAllBytes(Path.Combine(modFolder, DeletedAssetRelativePath), "going-away"u8.ToArray());
            File.WriteAllText(Path.Combine(modFolder, "meta.ini"), "[General]\nversion=1.0\n");
        });
    }

    private string GitDir => Path.Combine(_mod.ModFolder, ".git");
    private string RunGit(params string[] args) => GitCli.Run(GitDir, _mod.ModFolder, args);

    // Raw porcelain lines, untrimmed: the fixture's own GitStatus() trims the leading column, which
    // erases exactly the staged-vs-unstaged distinction this suite tests for.
    private IReadOnlyList<string> RawStatusLines() =>
        RunGit("status", "--porcelain").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private void WriteExternalRelease(float npcHeightMax)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(IndexedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew(IndexedModFixture.RaceEditorId);
        mod.Keywords.AddNew(IndexedModFixture.KeywordEditorId);
        var npc = mod.Npcs.AddNew(IndexedModFixture.NpcEditorId);
        npc.Race.SetTo(race);
        npc.HeightMax = npcHeightMax;
        mod.Npcs.AddNew(IndexedModFixture.OtherNpcEditorId);
        mod.WriteToBinary(Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName));
    }

    // The whole release: a new plugin binary, a hand-changed asset, a deleted asset, a version bump.
    private void ApplyExternalRelease()
    {
        WriteExternalRelease(0.9f);
        File.WriteAllBytes(Path.Combine(_mod.ModFolder, AssetRelativePath), "new-mesh-bytes"u8.ToArray());
        File.Delete(Path.Combine(_mod.ModFolder, DeletedAssetRelativePath));
        File.WriteAllText(Path.Combine(_mod.ModFolder, "meta.ini"), "[General]\nversion=2.0\n");
    }

    private static (ILoggerFactory factory, ModFolderWatcher watcher) Backend() =>
        (LoggerFactory.Create(_ => { }), TestWatcher.Inert());

    [Fact]
    public void Absorb_OverAHandChangedAndADeletedAsset_CommitsBothWithTheNewPlugin_TrailersAndRebase()
    {
        TrackWithAssets();
        ApplyExternalRelease();
        var (loggerFactory, watcher) = Backend();
        using var _dispose = loggerFactory;

        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(PluginEndpoints.AbsorbExternalChange(
            new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin), _mod.Holder,
            TestEditService.AbsorbHandler(), watcher, loggerFactory));

        Assert.True(ok.Value!.Succeeded, ok.Value.RefusalReason);
        Assert.Equal(RebaseOutcome.Clean, ok.Value.Rebase?.Outcome);

        Assert.Equal("new-mesh-bytes", RunGit("show", $"main:{AssetRelativePath}"));
        var mainTree = RunGit("ls-tree", "-r", "--name-only", "main").Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.DoesNotContain(DeletedAssetRelativePath, mainTree);

        var trailerBody = RunGit("log", "-1", "--format=%B", "main");
        Assert.Contains("Binary-SHA256: ", trailerBody, StringComparison.Ordinal);
        Assert.Contains("Upstream-Version: 2.0", trailerBody, StringComparison.Ordinal);
        Assert.Contains("Meta-SHA256: ", trailerBody, StringComparison.Ordinal);

        Assert.Equal("edit", RunGit("rev-parse", "--abbrev-ref", "HEAD").Trim());
        Assert.Equal(RunGit("rev-parse", "main").Trim(), RunGit("rev-parse", "HEAD").Trim());
    }

    [Fact]
    public void Keep_OverAHandChangedAndADeletedAsset_LeavesThePluginAsDirt_AndStagesTheAsset()
    {
        TrackWithAssets();
        ApplyExternalRelease();
        var (loggerFactory, watcher) = Backend();
        using var _dispose = loggerFactory;

        var before = SourceRepository.ChangedTrackedFilesOutsideSource(_mod.ModFolder);
        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(PluginEndpoints.KeepExternalChange(
            new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin), _mod.Holder,
            TestEditService.KeepHandler(), watcher, loggerFactory));

        Assert.True(ok.Value!.Succeeded, ok.Value.RefusalReason);
        Assert.NotEmpty(before);

        var status = RawStatusLines();
        var recordPath = _mod.RelativeSourcePath(_mod.Npc, "npc_", IndexedModFixture.NpcEditorId).Replace('\\', '/');
        // Unstaged, working-tree dirt. Contains rather than EndsWith: this fixture's own EditorID
        // carries " - ", which git's porcelain C-quotes, trailing the path with a closing quote.
        Assert.Contains(status, s => s.Contains(recordPath, StringComparison.Ordinal) && s.StartsWith(" M", StringComparison.Ordinal));
        // Staged: the asset's index matches its working tree, changed and deleted alike.
        Assert.Contains(status, s => s.EndsWith(AssetRelativePath, StringComparison.Ordinal) && s[0] is not (' ' or '?'));
        Assert.Contains(status, s => s.EndsWith(DeletedAssetRelativePath, StringComparison.Ordinal) && s[0] == 'D');
    }

    [Fact]
    public void UnderEdits_AHandChangedAsset_IsNeitherCommittedNorStagedByEitherAnswer()
    {
        _mod = IndexedModFixture.Tracked(); // The Edits preset, the fixture's own default.
        var assetPath = Path.Combine(_mod.ModFolder, AssetRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(assetPath)!);
        File.WriteAllBytes(assetPath, "hand-edited-outside-git"u8.ToArray());
        WriteExternalRelease(0.9f);

        Assert.Empty(SourceRepository.ChangedTrackedFilesOutsideSource(_mod.ModFolder));

        var (loggerFactory, watcher) = Backend();
        using var _dispose = loggerFactory;
        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(PluginEndpoints.AbsorbExternalChange(
            new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin), _mod.Holder,
            TestEditService.AbsorbHandler(), watcher, loggerFactory));

        Assert.True(ok.Value!.Succeeded, ok.Value.RefusalReason);
        Assert.DoesNotContain(AssetRelativePath, RunGit("ls-tree", "-r", "--name-only", "main"));
    }

    [Fact]
    public void UnderEdits_Keep_AHandChangedAsset_IsNeitherCommittedNorStagedEither()
    {
        _mod = IndexedModFixture.Tracked(); // The Edits preset, the fixture's own default.
        var assetPath = Path.Combine(_mod.ModFolder, AssetRelativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(assetPath)!);
        File.WriteAllBytes(assetPath, "hand-edited-outside-git"u8.ToArray());
        WriteExternalRelease(0.9f);

        Assert.Empty(SourceRepository.ChangedTrackedFilesOutsideSource(_mod.ModFolder));

        var (loggerFactory, watcher) = Backend();
        using var _dispose = loggerFactory;
        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(PluginEndpoints.KeepExternalChange(
            new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin), _mod.Holder,
            TestEditService.KeepHandler(), watcher, loggerFactory));

        Assert.True(ok.Value!.Succeeded, ok.Value.RefusalReason);
        Assert.DoesNotContain(RawStatusLines(), s => s.Contains(AssetRelativePath, StringComparison.Ordinal));
    }

    [Fact]
    public void Keep_OverAnAssetAlreadyDirtyInTheIndex_RefusesNamingThePath()
    {
        TrackWithAssets();
        ApplyExternalRelease();
        // A prior, unresolved answer already staged this exact path.
        RunGit("add", "-A", "--", AssetRelativePath);

        var (loggerFactory, watcher) = Backend();
        using var _dispose = loggerFactory;
        var ok = Assert.IsAssignableFrom<Ok<ExternalChangeActionResponse>>(PluginEndpoints.KeepExternalChange(
            new ExternalChangeActionRequest(IndexedModFixture.ModFolderOrigin), _mod.Holder,
            TestEditService.KeepHandler(), watcher, loggerFactory));

        Assert.False(ok.Value!.Succeeded);
        Assert.Contains(AssetRelativePath, ok.Value.RefusalReason, StringComparison.Ordinal);
    }

    // The rival this guards: reading git's own 0 exit as Clean even though the autostash's own
    // reapply conflicted and left the change in the stash — a silent wrong state (ADR-0019).
    [Fact]
    public void RebaseEditBranch_WhenReapplyingTheAutostashConflicts_ReportsConflicted_KeepingTheStash()
    {
        TrackWithAssets();

        // Main gains a baseline value for the asset, committed by plumbing — the edit branch's own
        // history and working tree are untouched by this step.
        File.WriteAllBytes(Path.Combine(_mod.ModFolder, AssetRelativePath), "main-baseline-mesh"u8.ToArray());
        var trailers = new TrackProvenance(null, null, new Dictionary<string, string>());
        SourceRepository.CommitPristineToMain(
            _mod.ModFolder, [], trailers,
            [new TrackedFileChange(AssetRelativePath, TrackedFileChangeKind.Modified, StagedAlready: false)]);

        // The edit branch separately holds staged dirt on that very same asset, with different bytes.
        File.WriteAllBytes(Path.Combine(_mod.ModFolder, AssetRelativePath), "staged-conflicting-mesh"u8.ToArray());
        RunGit("add", "-A", "--", AssetRelativePath);
        Assert.Empty(RunGit("stash", "list").Split('\n', StringSplitOptions.RemoveEmptyEntries));

        var result = SourceRepository.RebaseEditBranch(_mod.ModFolder);

        Assert.Equal(RebaseOutcome.Conflicted, result.Outcome);
        Assert.Contains(AssetRelativePath, result.ConflictedPaths);
        Assert.Contains("stash", result.RefusalReason, StringComparison.OrdinalIgnoreCase);
        Assert.NotEmpty(RunGit("stash", "list").Split('\n', StringSplitOptions.RemoveEmptyEntries));
    }
}
