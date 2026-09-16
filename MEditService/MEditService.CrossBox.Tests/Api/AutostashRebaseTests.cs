using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Api;

/// <summary>The rival this guards: reading git's own 0 exit as Clean even though the autostash's
/// reapply conflicted and left the change in the stash — a silent wrong state (ADR-0019).</summary>
public sealed class AutostashRebaseTests : IDisposable
{
    private const string AssetRelativePath = "Meshes/Thing.nif";

    private readonly IndexedModFixture _mod = IndexedModFixture.TrackedEverything(modFolder =>
    {
        Directory.CreateDirectory(Path.Combine(modFolder, "Meshes"));
        File.WriteAllBytes(Path.Combine(modFolder, AssetRelativePath), "original-mesh"u8.ToArray());
    });

    public void Dispose() => _mod.Dispose();

    private string RunGit(params string[] args) =>
        GitCli.Run(Path.Combine(_mod.ModFolder, ".git"), _mod.ModFolder, args);

    [Fact]
    public void RebaseEditBranch_WhenReapplyingTheAutostashConflicts_ReportsConflicted_KeepingTheStash()
    {
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
