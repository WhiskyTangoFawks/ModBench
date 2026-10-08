using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
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

    [PosixFact]
    public void Track_WhenEveryPluginIsRefused_LeavesTheHalfMadeRepositoryAsItWas()
    {
        CrashATrackAfterItMadeTheRepository();
        var before = GitDirContents();

        SourceRepository.Track(
            _modFolder, [BaselineWhoseSecondFileNeedsADirectoryTheFirstFileOccupies("Bad.esp")]);

        Assert.Equal(before, GitDirContents());
    }

    [PosixFact]
    public void Track_WhenTheCommitFails_LeavesTheHalfMadeRepositoryAsItWas()
    {
        CrashATrackAfterItMadeTheRepository();
        var before = GitDirContents();
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

        Assert.Subset(GitDirContents().ToHashSet(), before.ToHashSet());
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

    [PosixFact]
    public void Track_WhenTheCommitFails_LeavesAFileAnotherProgramPutInADirectoryItMade_AndNamesTheDirectory()
    {
        var theirs = Path.Combine(_modFolder, "plugin-source", "A.esp", "theirs.txt");

        var failure = TrackWhoseCommitHookRuns($"echo theirs > '{theirs}'");

        Assert.Equal("theirs", File.ReadAllText(theirs).Trim());
        Assert.Contains("plugin-source/A.esp — hold something this change did not write", failure.Message.Replace('\\', '/'));
        Assert.False(File.Exists(Path.Combine(_modFolder, "plugin-source", "A.esp", "npc_", "A.esp", "000001.json")));
    }

    [PosixFact]
    public void Track_WhenTheCommitFails_LeavesAFileAnotherProgramChanged_AndNamesIt()
    {
        var changed = Path.Combine(_modFolder, "plugin-source", "A.esp", "npc_", "A.esp", "000001.json");

        var failure = TrackWhoseCommitHookRuns($"echo theirs > '{changed}'");

        Assert.Equal("theirs", File.ReadAllText(changed).Trim());
        Assert.Contains("000001.json — changed by something else", failure.Message);
    }

    [PosixFact]
    public void Track_WhenTheCommitFails_LeavesAGitignoreAnotherProgramChanged_AndNamesIt()
    {
        var gitignore = Path.Combine(_modFolder, ".gitignore");

        var failure = TrackWhoseCommitHookRuns($"echo theirs > '{gitignore}'");

        Assert.Equal("theirs", File.ReadAllText(gitignore).Trim());
        Assert.Contains(".gitignore — changed by something else", failure.Message);
    }

    private Exception TrackWhoseCommitHookRuns(string script)
    {
        CrashATrackAfterItMadeTheRepository();
        GitHooks.Write(_modFolder, "pre-commit", $"{script}\nexit 1");
        return Assert.ThrowsAny<IOException>(() => SourceRepository.Track(_modFolder, [Baseline("A.esp")]));
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

    [PosixFact]
    public void Track_IntoTheHalfMadeRepositoryOfACrashedTrack_Recovers()
    {
        CrashATrackAfterItMadeTheRepository();

        Assert.False(SourceRepository.HoldsAnotherRepository(_modFolder));
        var refused = SourceRepository.Track(_modFolder, [Baseline("A.esp")]);

        Assert.Empty(refused);
        Assert.Equal(["Track SomeMod"], SubjectsOnMain());
    }

    private void CrashATrackAfterItMadeTheRepository()
    {
        using var template = new ScratchDirectory("medit-track-template-");
        GitHooks.Write(template, "pre-commit", "chmod 555 \"$(dirname \"$0\")/..\"\nexit 1");
        var previous = Environment.GetEnvironmentVariable("GIT_TEMPLATE_DIR");
        Environment.SetEnvironmentVariable("GIT_TEMPLATE_DIR", Path.Combine(template, ".git"));
        var gitDir = Path.Combine(_modFolder, ".git");
        try
        {
            Assert.ThrowsAny<UnauthorizedAccessException>(() => SourceRepository.Track(_modFolder, [Baseline("Crashed.esp")]));
        }
        finally
        {
            Environment.SetEnvironmentVariable("GIT_TEMPLATE_DIR", previous);
            FileModes.Set(gitDir, "755");
        }
        File.Delete(Path.Combine(gitDir, "hooks", "pre-commit"));
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
