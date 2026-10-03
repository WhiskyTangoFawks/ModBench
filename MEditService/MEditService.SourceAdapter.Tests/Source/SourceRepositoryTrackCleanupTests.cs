using MEditService.Codec.Serialization;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryTrackCleanupTests : IDisposable
{
    private const string ModName = "SomeMod";
    private readonly ScratchDirectory _root = new("medit-track-cleanup-");
    private readonly string _modFolder;

    public SourceRepositoryTrackCleanupTests() => _modFolder = Directory.CreateDirectory(Path.Combine(_root, ModName)).FullName;

    public void Dispose() => _root.Dispose();

    [Fact]
    public void Track_APluginWhoseFilesCannotAllBeWritten_IsRefused_LeavingNoneOfItsFiles_WhileThePluginsAroundItLand()
    {
        var refused = SourceRepository.Track(
            _modFolder, SourcePreset.Edits, [Baseline("A.esp"), BaselineWhoseSecondFileNeedsADirectoryTheFirstFileOccupies("Bad.esp"), Baseline("C.esp")]);

        Assert.Equal(["Bad.esp"], refused.Select(r => r.Plugin));
        Assert.Equal(["Track SomeMod", "Track A.esp", "Track C.esp"], SubjectsOnMain());
        Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source", "Bad.esp")));
        Assert.True(File.Exists(Path.Combine(_modFolder, "plugin-source", "C.esp", "npc_", "C.esp", "000001.json")));
        Assert.Equal("main", Git("symbolic-ref", "--short", "HEAD").Trim());
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

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
        Assert.Equal("main", Git("symbolic-ref", "--short", "HEAD").Trim());
    }

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
        Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source")));
    }

    private static (IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers) Baseline(string plugin) =>
        ([new TreeFile($"plugin-source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())], new BaselineTrailers(plugin, null, null));

    private static (IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers) BaselineWhoseSecondFileNeedsADirectoryTheFirstFileOccupies(string plugin) =>
        ([
            new TreeFile($"plugin-source/{plugin}/npc_", "{}"u8.ToArray()),
            new TreeFile($"plugin-source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray()),
        ], new BaselineTrailers(plugin, null, null));

    private string[] SubjectsOnMain() =>
        Git("log", "--reverse", "--format=%s", "refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
