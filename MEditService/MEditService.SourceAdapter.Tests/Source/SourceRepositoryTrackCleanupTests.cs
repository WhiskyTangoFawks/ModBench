using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Each plugin lands or is refused on its own, with no rollback beyond git's: a refused
/// plugin leaves nothing of its own, and the commits around it stand (decompile-plugin, Failure).</summary>
public sealed class SourceRepositoryTrackCleanupTests : IDisposable
{
    private const string ModName = "SomeMod";
    private readonly string _root = Directory.CreateTempSubdirectory("medit-track-cleanup-").FullName;
    private readonly string _modFolder;

    public SourceRepositoryTrackCleanupTests() => _modFolder = Directory.CreateDirectory(Path.Combine(_root, ModName)).FullName;

    public void Dispose() => Directory.Delete(_root, recursive: true);

    [Fact]
    public void Track_APluginWhoseFilesCannotAllBeWritten_IsRefused_LeavingNoneOfItsFiles_WhileThePluginsAroundItLand()
    {
        var refused = SourceRepository.Track(
            _modFolder, SourcePreset.Edits, [Baseline("A.esp"), UnwritableBaseline("Bad.esp"), Baseline("C.esp")]);

        Assert.Equal(["Bad.esp"], refused.Select(r => r.Plugin));
        Assert.Equal(["Track SomeMod", "Track A.esp", "Track C.esp"], SubjectsOnMain());
        Assert.False(Directory.Exists(Path.Combine(_modFolder, "source", "Bad.esp")));
        Assert.True(File.Exists(Path.Combine(_modFolder, "source", "C.esp", "npc_", "C.esp", "000001.json")));
        Assert.Equal("edit", Git("symbolic-ref", "--short", "HEAD").Trim());
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    [Fact]
    public void Track_IntoAnExistingRepository_RefusesAPluginWhoseFilesCannotAllBeWritten_AndCommitsTheRest()
    {
        PluginBaselines.Track(_modFolder, SourcePreset.Edits, Baseline("A.esp").Files);
        var editBefore = Git("rev-parse", "refs/heads/edit");

        var refused = SourceRepository.Track(
            _modFolder, SourcePreset.Edits, [UnwritableBaseline("Bad.esp"), Baseline("C.esp")]);

        Assert.Equal(["Bad.esp"], refused.Select(r => r.Plugin));
        Assert.Equal(["Track SomeMod", "Track A.esp", "Track C.esp"], SubjectsOnMain());
        Assert.Equal(editBefore, Git("rev-parse", "refs/heads/edit"));
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    private static (IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers) Baseline(string plugin) =>
        ([new TreeFile($"source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())], new BaselineTrailers(plugin, null, null, null));

    // The first file lands where the second needs a directory, so the write fails after some of the
    // plugin's files are already on disk.
    private static (IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers) UnwritableBaseline(string plugin) =>
        ([
            new TreeFile($"source/{plugin}/npc_", "{}"u8.ToArray()),
            new TreeFile($"source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray()),
        ], new BaselineTrailers(plugin, null, null, null));

    private string[] SubjectsOnMain() =>
        Git("log", "--reverse", "--format=%s", "refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
