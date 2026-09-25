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

    // ADR-0003: a failed first Track leaves a .git with no main behind, and nothing but Track itself
    // recovers from that without a hand delete.
    [Fact]
    public void Track_AfterAFailedTrackOfTheModsOwnFiles_IsNotTracked_AndTrackingAgainCreatesTheRepository()
    {
        var asset = Path.Combine(_modFolder, "Locked.dds");
        File.WriteAllText(asset, "pixels");
        FileModes.Set(asset, "000");
        try
        {
            Assert.ThrowsAny<InvalidOperationException>(
                () => SourceRepository.Track(_modFolder, SourcePreset.Everything, [Baseline("A.esp")]));
        }
        finally
        {
            FileModes.Set(asset, "600");
        }
        Assert.True(Directory.Exists(Path.Combine(_modFolder, ".git")));
        Assert.False(SourceRepository.IsTracked(_modFolder));

        var refused = SourceRepository.Track(_modFolder, SourcePreset.Everything, [Baseline("A.esp")]);

        Assert.Empty(refused);
        Assert.Equal(["Track SomeMod", "Track A.esp"], SubjectsOnMain());
        Assert.True(SourceRepository.IsTracked(_modFolder));
        Assert.Equal("edit", Git("symbolic-ref", "--short", "HEAD").Trim());
    }

    // ADR-0003: a repository with history but no main is someone else's; Track throws before writing.
    [Fact]
    public void Track_IntoARepositoryWithHistoryButNoMain_ThrowsAndChangesNothingOfIt()
    {
        Git("init", "-q", "-b", "master");
        File.WriteAllText(Path.Combine(_modFolder, ".gitignore"), "theirs\n");
        Git("add", ".gitignore");
        Git("-c", "user.name=Them", "-c", "user.email=them@localhost", "commit", "-q", "-m", "Their own commit");
        var logBefore = Git("log", "--all", "--format=%H %s");
        var configBefore = File.ReadAllBytes(Path.Combine(_modFolder, ".git", "config"));

        Assert.True(SourceRepository.HoldsAnotherRepository(_modFolder));
        Assert.Throws<InvalidOperationException>(
            () => SourceRepository.Track(_modFolder, SourcePreset.Edits, [Baseline("A.esp")]));

        Assert.Equal(logBefore, Git("log", "--all", "--format=%H %s"));
        Assert.Equal("theirs\n", File.ReadAllText(Path.Combine(_modFolder, ".gitignore")));
        Assert.Equal(configBefore, File.ReadAllBytes(Path.Combine(_modFolder, ".git", "config")));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, "source")));
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
