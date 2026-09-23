using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>The rival this guards: reading git's own 0 exit as Clean even though the autostash's
/// reapply conflicted and left the change in the stash — a silent wrong state (ADR-0019).</summary>
public sealed class AutostashRebaseTests : IDisposable
{
    private const string PluginName = "Autostash.esp";
    private const string AssetRelativePath = "Meshes/Thing.nif";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-autostash-").FullName;

    // The Everything preset, so the asset beside the source tree is tracked and a rebase has to
    // stash it.
    public AutostashRebaseTests()
    {
        Directory.CreateDirectory(Path.Combine(_modFolder, "Meshes"));
        File.WriteAllBytes(Path.Combine(_modFolder, AssetRelativePath), "original-mesh"u8.ToArray());
        SourceRepository.Track(
            _modFolder,
            SourcePreset.Everything,
            [new TreeFile(SourceRepository.HeaderDocumentFor(PluginName), "{\"MasterReferences\": []}"u8.ToArray())],
            new TrackProvenance(null, null, new Dictionary<string, string>()));
    }

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
    }

    private string Git(params string[] args) =>
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    [Fact]
    public void RebaseEditBranch_WhenReapplyingTheAutostashConflicts_ReportsConflicted_KeepingTheStash()
    {
        // Main gains a baseline value for the asset, committed by plumbing — the edit branch's own
        // history and working tree are untouched by this step.
        File.WriteAllBytes(Path.Combine(_modFolder, AssetRelativePath), "main-baseline-mesh"u8.ToArray());
        var trailers = new TrackProvenance(null, null, new Dictionary<string, string>());
        SourceRepository.CommitPristineToMain(
            _modFolder, [], trailers,
            [new TrackedFileChange(AssetRelativePath, TrackedFileChangeKind.Modified, StagedAlready: false)]);

        // The edit branch separately holds staged dirt on that very same asset, with different bytes.
        File.WriteAllBytes(Path.Combine(_modFolder, AssetRelativePath), "staged-conflicting-mesh"u8.ToArray());
        Git("add", "-A", "--", AssetRelativePath);
        Assert.Empty(Git("stash", "list").Split('\n', StringSplitOptions.RemoveEmptyEntries));

        var result = SourceRepository.RebaseEditBranch(_modFolder);

        Assert.Equal(RebaseOutcome.Conflicted, result.Outcome);
        Assert.Contains(AssetRelativePath, result.ConflictedPaths);
        Assert.Contains("stash", result.RefusalReason, StringComparison.OrdinalIgnoreCase);
        Assert.NotEmpty(Git("stash", "list").Split('\n', StringSplitOptions.RemoveEmptyEntries));
    }
}
