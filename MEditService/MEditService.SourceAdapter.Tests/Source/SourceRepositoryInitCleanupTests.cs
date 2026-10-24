using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryInitCleanupTests : IDisposable
{
    private const string ModName = "SomeMod";
    private readonly ScratchDirectory _root = new("medit-init-cleanup-");
    private readonly string _modFolder;

    public SourceRepositoryInitCleanupTests() => _modFolder = Directory.CreateDirectory(Path.Combine(_root, ModName)).FullName;

    public void Dispose() => _root.Dispose();

    [Fact]
    public void APluginWhoseFilesCannotAllBeWritten_RefusesTheInit_LeavingNoRepositoryAndNoSourceOfThePluginsAroundIt()
    {
        var failure = TestAdapters.Source().Init(
            _modFolder, [PluginBaselines.OneRecordOf("A.esp"), BaselineWhoseSecondFileNeedsADirectoryTheFirstFileOccupies("Bad.esp"), PluginBaselines.OneRecordOf("C.esp")]);

        Assert.StartsWith("Bad.esp's source could not be written: ", failure.Require().Reason, StringComparison.Ordinal);
        Assert.False(TestAdapters.Source().IsSourceMod(_modFolder));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, ".git")));
        Assert.False(File.Exists(Path.Combine(_modFolder, ".gitignore")));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source")));
    }

    [Fact]
    public void AnAssetThatCannotBeRead_RefusesTheInitNamingIt_LeavingNoRepositoryNoAssetsAndNoSource()
    {
        var failure = TestAdapters.Source().Init(_modFolder, ModName, [PluginBaselines.OneRecordOf("A.esp")],
        [
            new Asset("textures/a.dds", () => new MemoryStream("a"u8.ToArray())),
            new Asset("textures/held.dds", () => throw new IOException("textures/held.dds is held by another process")),
        ]);

        Assert.Contains("textures/held.dds is held by another process", failure.Require().Reason, StringComparison.Ordinal);
        Assert.False(TestAdapters.Source().IsSourceMod(_modFolder));
        Assert.Empty(Directory.EnumerateFileSystemEntries(_modFolder));
    }

    [Fact]
    public void AnInit_TakesBackAnAssetItReplaced_WhenALaterAssetFails()
    {
        var existing = Path.Combine(_modFolder, "assets", "a.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(existing).Require());
        File.WriteAllText(existing, "theirs");

        TestAdapters.Source().Init(_modFolder, ModName, [PluginBaselines.OneRecordOf("A.esp")],
        [
            new Asset("a.txt", () => new MemoryStream("ours"u8.ToArray())),
            new Asset("b.txt", () => throw new IOException("b.txt is held by another process")),
        ]);

        Assert.Equal("theirs", File.ReadAllText(existing));
    }

    [PosixFact]
    public void APluginWhoseFilesCannotBeWritten_LeavesTheHalfMadeRepositoryAsItWas()
    {
        CrashAnInitAfterItMadeTheRepository();
        var before = GitDirContents();

        TestAdapters.Source().Init(
            _modFolder, [BaselineWhoseSecondFileNeedsADirectoryTheFirstFileOccupies("Bad.esp")]);

        Assert.Equal(before, GitDirContents());
    }

    [PosixFact]
    public void AnInitWhoseCommitFails_LeavesTheHalfMadeRepositoryAsItWas()
    {
        CrashAnInitAfterItMadeTheRepository();
        var before = GitDirContents();
        var asset = UnreadableFileTheCommitCannotAdd();
        FileModes.Set(asset, "000");
        try
        {
            InitRefused("A.esp");
        }
        finally
        {
            FileModes.Set(asset, "600");
        }

        Assert.Subset(GitDirContents().ToHashSet(), before.ToHashSet());
    }

    [PosixFact]
    public void AnInitWhoseCommitFails_RestoresTheSourceFileItReplaced()
    {
        var existing = Path.Combine(_modFolder, "plugin-source", "A.esp", "npc_", "A.esp", "000001.json");
        Directory.CreateDirectory(Path.GetDirectoryName(existing).Require());
        File.WriteAllText(existing, "theirs");
        var asset = UnreadableFileTheCommitCannotAdd();
        FileModes.Set(asset, "000");
        try
        {
            InitRefused("A.esp");
        }
        finally
        {
            FileModes.Set(asset, "600");
        }

        Assert.Equal("theirs", File.ReadAllText(existing));
    }

    [Fact]
    public void AnInitWhosePluginWriteThrowsAnythingElse_TakesBackEveryPluginsFiles_AndThrows()
    {
        var nulInPath = new TreeFile("npc_/\0.json", "{}"u8.ToArray());

        Assert.ThrowsAny<ArgumentException>(
            () => TestAdapters.Source().Init(_modFolder, [PluginBaselines.OneRecordOf("A.esp"), ([nulInPath], PluginBaselines.Decompiled("Bad.esp"))]));

        Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source")));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, ".git")));
    }

    [PosixFact]
    public void AnInitWhoseCommitFails_LeavesAFileAnotherProgramPutInADirectoryItMade_AndNamesTheDirectory()
    {
        var theirs = Path.Combine(_modFolder, "plugin-source", "A.esp", "theirs.txt");

        var failure = InitWhoseCommitHookRuns($"echo theirs > '{theirs}'");

        Assert.Equal("theirs", File.ReadAllText(theirs).Trim());
        Assert.Contains("plugin-source/A.esp — holds something this change did not write", failure.Replace('\\', '/'));
        Assert.False(File.Exists(Path.Combine(_modFolder, "plugin-source", "A.esp", "npc_", "A.esp", "000001.json")));
    }

    [PosixFact]
    public void AnInitWhoseCommitFails_LeavesAFileAnotherProgramChanged_AndNamesIt()
    {
        var changed = Path.Combine(_modFolder, "plugin-source", "A.esp", "npc_", "A.esp", "000001.json");

        var failure = InitWhoseCommitHookRuns($"echo theirs > '{changed}'");

        Assert.Equal("theirs", File.ReadAllText(changed).Trim());
        Assert.Contains("000001.json — changed by something else", failure, StringComparison.Ordinal);
    }

    [PosixFact]
    public void AnInitWhoseCommitFails_LeavesAGitignoreAnotherProgramChanged_AndNamesIt()
    {
        var gitignore = Path.Combine(_modFolder, ".gitignore");

        var failure = InitWhoseCommitHookRuns($"echo theirs > '{gitignore}'");

        Assert.Equal("theirs", File.ReadAllText(gitignore).Trim());
        Assert.Contains(".gitignore — changed by something else", failure, StringComparison.Ordinal);
    }

    private string InitWhoseCommitHookRuns(string script)
    {
        CrashAnInitAfterItMadeTheRepository();
        GitHooks.Write(_modFolder, "pre-commit", $"{script}\nexit 1");
        return InitRefused("A.esp");
    }

    private string InitRefused(string plugin) => TestAdapters.Source().Init(_modFolder, [PluginBaselines.OneRecordOf(plugin)]).Require().Reason;

    [PosixFact]
    public void AnInitWhoseCommitFails_TakesBackWhatItMade_AndAnInitAgainCreatesTheRepository()
    {
        var asset = UnreadableFileTheCommitCannotAdd();
        FileModes.Set(asset, "000");
        try
        {
            InitRefused("A.esp");
        }
        finally
        {
            FileModes.Set(asset, "600");
        }
        Assert.False(Directory.Exists(Path.Combine(_modFolder, ".git")));
        Assert.False(File.Exists(Path.Combine(_modFolder, ".gitignore")));
        Assert.Equal([asset], Directory.GetFiles(Path.Combine(_modFolder, "plugin-source"), "*", SearchOption.AllDirectories));
        File.Delete(asset);

        Assert.Null(TestAdapters.Source().Init(_modFolder, [PluginBaselines.OneRecordOf("A.esp")]));

        Assert.Equal(["Init SomeMod"], SubjectsOnMain());
        Assert.True(TestAdapters.Source().IsSourceMod(_modFolder));
        Assert.Equal("main", Git("symbolic-ref", "--short", "HEAD").Trim());
    }

    [Fact]
    public void AnInitIntoARepositoryWithHistoryButNoMain_IsADefect_AndChangesNothingOfIt()
    {
        Git("init", "-q", "-b", "master");
        File.WriteAllText(Path.Combine(_modFolder, ".gitignore"), "theirs\n");
        Git("add", ".gitignore");
        Git("-c", "user.name=Them", "-c", "user.email=them@localhost", "commit", "-q", "-m", "Their own commit");
        var logBefore = Git("log", "--all", "--format=%H %s");
        var configBefore = File.ReadAllBytes(Path.Combine(_modFolder, ".git", "config"));

        Assert.True(TestAdapters.Source().HoldsAnotherRepository(_modFolder));
        Assert.Throws<InvalidOperationException>(
            () => TestAdapters.Source().Init(_modFolder, [PluginBaselines.OneRecordOf("A.esp")]));

        Assert.Equal(logBefore, Git("log", "--all", "--format=%H %s"));
        Assert.Equal("theirs\n", File.ReadAllText(Path.Combine(_modFolder, ".gitignore")));
        Assert.Equal(configBefore, File.ReadAllBytes(Path.Combine(_modFolder, ".git", "config")));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source")));
    }

    [Fact]
    public void AnInitIntoABranchlessRepositoryTheUserMade_IsADefect_AndChangesNothingOfIt()
    {
        Git("init", "-q", "-b", "main");
        var before = GitDirContents();

        Assert.True(TestAdapters.Source().HoldsAnotherRepository(_modFolder));
        Assert.Throws<InvalidOperationException>(
            () => TestAdapters.Source().Init(_modFolder, [PluginBaselines.OneRecordOf("A.esp")]));

        Assert.Equal(before, GitDirContents());
        Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source")));
    }

    [Fact]
    public void AnInitWhosePluginWriteADefectStops_NamesWhatAnotherProgramPutInADirectoryItMade_AndIsNotARefusal()
    {
        var theirs = Path.Combine(_modFolder, "plugin-source", "A.esp", "theirs.txt");
        var files = new FilesThatFailMidway(
            new TreeFile("npc_/A.esp/000001.json", "{}"u8.ToArray()),
            () => File.WriteAllText(theirs, "theirs"));

        var failure = Assert.Throws<AggregateException>(
            () => TestAdapters.Source().Init(_modFolder, [(files, PluginBaselines.Decompiled("A.esp"))]));

        Assert.IsType<InvalidCastException>(failure.InnerException);
        Assert.Contains("plugin-source/A.esp \u2014 holds something this change did not write", failure.Message.Replace('\\', '/'));
        Assert.Equal("theirs", File.ReadAllText(theirs));
    }

    private sealed class FilesThatFailMidway(TreeFile first, Action beforeFailing) : IReadOnlyList<TreeFile>
    {
        public int Count => 2;

        public TreeFile this[int index] => index == 0 ? first : throw new InvalidCastException("defect");

        public IEnumerator<TreeFile> GetEnumerator()
        {
            yield return first;
            beforeFailing();
            throw new InvalidCastException("defect");
        }

        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }

    [PosixFact]
    public void AnInitIntoTheHalfMadeRepositoryOfACrashedInit_Recovers()
    {
        CrashAnInitAfterItMadeTheRepository();

        Assert.False(TestAdapters.Source().HoldsAnotherRepository(_modFolder));
        Assert.Null(TestAdapters.Source().Init(_modFolder, [PluginBaselines.OneRecordOf("A.esp")]));

        Assert.Equal(["Init SomeMod"], SubjectsOnMain());
    }

    private void CrashAnInitAfterItMadeTheRepository()
    {
        using var template = new ScratchDirectory("medit-init-template-");
        GitHooks.Write(template, "pre-commit", "chmod 555 \"$(dirname \"$0\")/..\"\nexit 1");
        var previous = Environment.GetEnvironmentVariable("GIT_TEMPLATE_DIR");
        Environment.SetEnvironmentVariable("GIT_TEMPLATE_DIR", Path.Combine(template, ".git"));
        var gitDir = Path.Combine(_modFolder, ".git");
        try
        {
            Assert.Contains(".git \u2014 could not be restored: ", InitRefused("Crashed.esp"), StringComparison.Ordinal);
            Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source")));
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

    private static (IReadOnlyList<TreeFile> Files, DecompiledPlugin Plugin) BaselineWhoseSecondFileNeedsADirectoryTheFirstFileOccupies(string plugin) =>
        ([
            new TreeFile("npc_", "{}"u8.ToArray()),
            new TreeFile($"npc_/{plugin}/000001.json", "{}"u8.ToArray()),
        ], PluginBaselines.Decompiled(plugin));

    private string[] SubjectsOnMain() =>
        Git("log", "--reverse", "--format=%s", "refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
