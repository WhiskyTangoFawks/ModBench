using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
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
    public void Track_APluginWhoseFilesCannotAllBeWritten_IsRefused_LeavingNoRepositoryAndNoSourceOfThePluginsAroundIt()
    {
        var refused = SourceRepository.Track(
            _modFolder, [Baseline("A.esp"), BaselineWhoseSecondFileNeedsADirectoryTheFirstFileOccupies("Bad.esp"), Baseline("C.esp")]);

        Assert.Equal(["Bad.esp"], refused.Select(r => r.Plugin));
        Assert.False(SourceRepository.IsTracked(_modFolder));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, ".git")));
        Assert.False(File.Exists(Path.Combine(_modFolder, ".gitignore")));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source")));
    }

    [Fact]
    public void Track_WhenEveryPluginIsRefused_LeavesNoRepositoryAndNoGitignore()
    {
        var refused = SourceRepository.Track(
            _modFolder, [BaselineWhoseSecondFileNeedsADirectoryTheFirstFileOccupies("Bad.esp")]);

        Assert.Equal(["Bad.esp"], refused.Select(r => r.Plugin));
        Assert.False(SourceRepository.IsTracked(_modFolder));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, ".git")));
        Assert.False(File.Exists(Path.Combine(_modFolder, ".gitignore")));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source")));
    }

    [Fact]
    public void Track_WhenEveryPluginIsRefused_LeavesTheHalfMadeRepositoryAsItWas()
    {
        var theirs = Directory.CreateDirectory(Path.Combine(_modFolder, ".git")).FullName;
        File.WriteAllText(Path.Combine(theirs, "config"), "[medit]\n\ttrack = true\n[remote \"origin\"]\n");

        SourceRepository.Track(
            _modFolder, [BaselineWhoseSecondFileNeedsADirectoryTheFirstFileOccupies("Bad.esp")]);

        Assert.Equal("[medit]\n\ttrack = true\n[remote \"origin\"]\n", File.ReadAllText(Path.Combine(theirs, "config")));
    }

    [Fact]
    public void Track_WhenTheCommitFails_LeavesTheHalfMadeRepositoryAsItWas()
    {
        var theirs = Directory.CreateDirectory(Path.Combine(_modFolder, ".git")).FullName;
        File.WriteAllText(Path.Combine(theirs, "config"), "[medit]\n\ttrack = true\n");
        File.WriteAllText(Path.Combine(theirs, "marker"), "theirs");
        var asset = UnreadableFileTheCommitCannotAdd();
        FileModes.Set(asset, "000");
        try
        {
            Assert.ThrowsAny<InvalidOperationException>(
                () => SourceRepository.Track(_modFolder, [Baseline("A.esp")]));
        }
        finally
        {
            FileModes.Set(asset, "600");
        }

        Assert.Equal("theirs", File.ReadAllText(Path.Combine(theirs, "marker")));
    }

    [Fact]
    public void Track_WhenTheCommitFails_RestoresTheSourceFileItReplaced()
    {
        var existing = Path.Combine(_modFolder, "plugin-source", "A.esp", "npc_", "A.esp", "000001.json");
        Directory.CreateDirectory(Path.GetDirectoryName(existing).Require());
        File.WriteAllText(existing, "theirs");
        var asset = UnreadableFileTheCommitCannotAdd();
        FileModes.Set(asset, "000");
        try
        {
            Assert.ThrowsAny<InvalidOperationException>(
                () => SourceRepository.Track(_modFolder, [Baseline("A.esp")]));
        }
        finally
        {
            FileModes.Set(asset, "600");
        }

        Assert.Equal("theirs", File.ReadAllText(existing));
    }

    [Fact]
    public void Track_WhenAPluginsWriteThrowsAnythingElse_TakesBackEveryPluginsFiles_AndThrows()
    {
        var nulInPath = new TreeFile("plugin-source/Bad.esp/npc_/\0.json", "{}"u8.ToArray());

        Assert.ThrowsAny<ArgumentException>(
            () => SourceRepository.Track(_modFolder, [Baseline("A.esp"), ([nulInPath], new DecompiledPlugin("Bad.esp", null))]));

        Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source")));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, ".git")));
    }

    [Fact]
    public void Track_WhenTheCommitFails_LeavesAFileAnotherProgramPutInADirectoryItMade_AndNamesTheDirectory()
    {
        var theirs = Path.Combine(_modFolder, "plugin-source", "A.esp", "theirs.txt");
        var failure = TrackWhoseCommitHookRuns("echo theirs > plugin-source/A.esp/theirs.txt", [Baseline("A.esp")]);

        Assert.Equal("theirs", File.ReadAllText(theirs).Trim());
        Assert.Contains("plugin-source/A.esp holds something Modbench did not write", failure.Message.Replace('\\', '/'));
        Assert.False(File.Exists(Path.Combine(_modFolder, "plugin-source", "A.esp", "npc_", "A.esp", "000001.json")));
    }

    [Fact]
    public void Track_WhenTheCommitFails_LeavesAFileAnotherProgramChanged_AndNamesIt()
    {
        var changed = Path.Combine(_modFolder, "plugin-source", "A.esp", "npc_", "A.esp", "000001.json");
        var failure = TrackWhoseCommitHookRuns("echo theirs > plugin-source/A.esp/npc_/A.esp/000001.json", [Baseline("A.esp")]);

        Assert.Equal("theirs", File.ReadAllText(changed).Trim());
        Assert.Contains("000001.json was changed by another program", failure.Message);
    }

    private Exception TrackWhoseCommitHookRuns(
        string script, IReadOnlyList<(IReadOnlyList<TreeFile> Files, DecompiledPlugin Plugin)> plugins)
    {
        Directory.CreateDirectory(Path.Combine(_modFolder, ".git"));
        File.WriteAllText(Path.Combine(_modFolder, ".git", "config"), "[medit]\n\ttrack = true\n");
        GitHooks.RunThenRefuse(_modFolder, "pre-commit", script);
        return Assert.ThrowsAny<IOException>(() => SourceRepository.Track(_modFolder, plugins));
    }

    [Fact]
    public void Track_WhenTheCommitFails_TakesBackWhatItMade_AndTrackingAgainCreatesTheRepository()
    {
        var asset = UnreadableFileTheCommitCannotAdd();
        FileModes.Set(asset, "000");
        try
        {
            Assert.ThrowsAny<InvalidOperationException>(
                () => SourceRepository.Track(_modFolder, [Baseline("A.esp")]));
        }
        finally
        {
            FileModes.Set(asset, "600");
        }
        Assert.False(Directory.Exists(Path.Combine(_modFolder, ".git")));
        Assert.False(File.Exists(Path.Combine(_modFolder, ".gitignore")));
        Assert.Equal([asset], Directory.GetFiles(Path.Combine(_modFolder, "plugin-source"), "*", SearchOption.AllDirectories));
        File.Delete(asset);

        var refused = SourceRepository.Track(_modFolder, [Baseline("A.esp")]);

        Assert.Empty(refused);
        Assert.Equal(["Track SomeMod"], SubjectsOnMain());
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
            () => SourceRepository.Track(_modFolder, [Baseline("A.esp")]));

        Assert.Equal(logBefore, Git("log", "--all", "--format=%H %s"));
        Assert.Equal("theirs\n", File.ReadAllText(Path.Combine(_modFolder, ".gitignore")));
        Assert.Equal(configBefore, File.ReadAllBytes(Path.Combine(_modFolder, ".git", "config")));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source")));
    }

    [Fact]
    public void Track_IntoABranchlessRepositoryTheUserMade_ThrowsAndChangesNothingOfIt()
    {
        Git("init", "-q", "-b", "main");
        var before = GitDirContents();

        Assert.True(SourceRepository.HoldsAnotherRepository(_modFolder));
        Assert.Throws<InvalidOperationException>(
            () => SourceRepository.Track(_modFolder, [Baseline("A.esp")]));

        Assert.Equal(before, GitDirContents());
        Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source")));
    }

    [Fact]
    public void Track_IntoTheHalfMadeRepositoryOfACrashedTrack_Recovers()
    {
        Git("init", "-q", "-b", "main");
        Git("config", "medit.track", "true");

        Assert.False(SourceRepository.HoldsAnotherRepository(_modFolder));
        var refused = SourceRepository.Track(_modFolder, [Baseline("A.esp")]);

        Assert.Empty(refused);
        Assert.Equal(["Track SomeMod"], SubjectsOnMain());
    }

    private List<(string Path, string Hash)> GitDirContents() =>
        [.. Directory.EnumerateFiles(Path.Combine(_modFolder, ".git"), "*", SearchOption.AllDirectories)
            .Order(StringComparer.Ordinal)
            .Select(file => (file, Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(file)))))];

    private string UnreadableFileTheCommitCannotAdd()
    {
        var path = Path.Combine(_modFolder, "plugin-source", "Other.esp", "Locked.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path).Require());
        File.WriteAllText(path, "{}");
        return path;
    }

    private static (IReadOnlyList<TreeFile> Files, DecompiledPlugin Plugin) Baseline(string plugin) =>
        ([new TreeFile($"plugin-source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())], new DecompiledPlugin(plugin, null));

    private static (IReadOnlyList<TreeFile> Files, DecompiledPlugin Plugin) BaselineWhoseSecondFileNeedsADirectoryTheFirstFileOccupies(string plugin) =>
        ([
            new TreeFile($"plugin-source/{plugin}/npc_", "{}"u8.ToArray()),
            new TreeFile($"plugin-source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray()),
        ], new DecompiledPlugin(plugin, null));

    private string[] SubjectsOnMain() =>
        Git("log", "--reverse", "--format=%s", "refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
