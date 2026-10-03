using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryReplaceSourceTests : IDisposable
{
    private const string Plugin = "A.esp";
    private const string Sha = "ABCDEF0123";
    private readonly ScratchDirectory _modFolder = new("medit-replace-source-");

    public SourceRepositoryReplaceSourceTests() =>
        PluginBaselines.Track(_modFolder, SourcePreset.Edits, [File("npc_/A.esp/000001.json", "{\"was\":1}")]);

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void ReplaceSourceFrom_LeavesExactlyTheNewFiles_AndParksTheBinaryAlone()
    {
        Repository.ReplaceSourceFrom(Plugin, [File("npc_/A.esp/000002.json", "{\"now\":2}")], Sha);

        Assert.Equal(["npc_/A.esp/000002.json"], FilesUnderRoot());
        Assert.Equal([Sha], SourceRepository.ParkedCompileBinarySha256s(_modFolder, Plugin));
        Assert.Equal(" D plugin-source/A.esp/npc_/A.esp/000001.json", Git("status", "--porcelain", "--untracked-files=no").TrimEnd('\n'));
    }

    [Fact]
    public void ReplaceSourceFrom_AFileThatCannotBeWritten_LeavesTheSourceAndTheRefAsTheyWere()
    {
        var refBefore = Git("rev-parse", SourceRepository.LastCompileRef(Plugin));

        TreeFile[] secondFileNeedsADirectoryTheFirstOccupies = [File("npc_", "{}"), File("npc_/A.esp/000002.json", "{}")];

        Assert.ThrowsAny<IOException>(() => Repository.ReplaceSourceFrom(
            Plugin, secondFileNeedsADirectoryTheFirstOccupies, Sha));

        Assert.Equal(["npc_/A.esp/000001.json"], FilesUnderRoot());
        Assert.Equal("{\"was\":1}", System.IO.File.ReadAllText(Path.Combine(Root, "npc_", "A.esp", "000001.json")));
        Assert.Equal(refBefore, Git("rev-parse", SourceRepository.LastCompileRef(Plugin)));
    }

    [Fact]
    public void ReplaceSourceFrom_ParksASnapshotOfWhatTheWorkingTreeHoldsNow_UntrackedSourceIncluded_NamedForDecompile()
    {
        Repository.ReplaceSourceFrom(Plugin, [File("npc_/A.esp/000002.json", "{\"now\":2}")], Sha);

        var parked = SourceRepository.LastCompileRef(Plugin);
        Assert.Equal(
            [".gitignore", "plugin-source/A.esp/npc_/A.esp/000002.json"],
            Git("ls-tree", "-r", "--name-only", parked).Split('\n', StringSplitOptions.RemoveEmptyEntries));
        Assert.Equal("{\"now\":2}", Git("show", $"{parked}:plugin-source/A.esp/npc_/A.esp/000002.json"));
        Assert.Equal("Decompile: A.esp", Git("log", "-1", "--format=%s", parked).Trim());
    }

    [Fact]
    public void ReplaceSourceFrom_OnABranchWithNoCommitYetWhereGitRefusesToParkAfterEveryFileIsWritten_LeavesTheSourceAndTheRefAsTheyWere()
    {
        var refBefore = Git("rev-parse", SourceRepository.LastCompileRef(Plugin));
        Git("checkout", "-q", "--orphan", "unborn");

        Assert.ThrowsAny<InvalidOperationException>(() => Repository.ReplaceSourceFrom(
            Plugin, [File("npc_/A.esp/000002.json", "{}")], Sha));

        Assert.Equal(["npc_/A.esp/000001.json"], FilesUnderRoot());
        Assert.Equal("{\"was\":1}", System.IO.File.ReadAllText(Path.Combine(Root, "npc_", "A.esp", "000001.json")));
        Assert.Equal(refBefore, Git("rev-parse", SourceRepository.LastCompileRef(Plugin)));
    }

    [Fact]
    public void ReplaceSourceFrom_IntoAModFolderAnotherToolRemoved_NamesTheMissingRepository_AndRecreatesNothing()
    {
        var repository = Repository;
        Directory.Delete(_modFolder, recursive: true);

        var refused = Assert.Throws<InvalidOperationException>(() => repository.ReplaceSourceFrom(
            Plugin, [File("npc_/A.esp/000002.json", "{}")], Sha));

        Assert.Contains("holds no repository", refused.Message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(_modFolder));
    }

    [Fact]
    public void AGitStep_InAModFolderAnotherToolRemoved_FailsNamingTheFolder_NotGit()
    {
        Directory.Delete(_modFolder, recursive: true);

        var failure = Assert.ThrowsAny<Exception>(() => SourceRepository.ParkCompileSnapshot(_modFolder, Plugin, Sha));

        Assert.IsNotType<GitUnavailableException>(failure);
        Assert.Contains(_modFolder, failure.Message, StringComparison.Ordinal);
    }

    private SourceRepository Repository =>
        SourceRepository.Open(_modFolder, GameRelease.Fallout4) ?? throw new InvalidOperationException("Expected the fixture tracked.");

    private string Root => SourceRepository.RootIn(_modFolder, Plugin);

    private static TreeFile File(string underRoot, string text) =>
        new($"plugin-source/{Plugin}/{underRoot}", System.Text.Encoding.UTF8.GetBytes(text));

    private string[] FilesUnderRoot() =>
        [.. Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(Root, path).Replace('\\', '/'))
            .Order(StringComparer.Ordinal)];

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SourceRepositoryReplaceSourceWithoutGitTests : IDisposable
{
    private readonly ScratchDirectory _modFolder = new("medit-replace-source-nogit-");

    public SourceRepositoryReplaceSourceWithoutGitTests() =>
        PluginBaselines.Track(_modFolder, SourcePreset.Edits,
            [new TreeFile("plugin-source/A.esp/npc_/A.esp/000001.json", "{\"was\":1}"u8.ToArray())]);

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void ReplaceSourceFrom_WithGitGoneFromPathAfterTheUpFrontCheck_ThrowsTheOsReason_AndLeavesTheSourceAsItWas()
    {
        var repository = SourceRepository.Open(_modFolder, GameRelease.Fallout4) ?? throw new InvalidOperationException("Expected the fixture tracked.");
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            Assert.Throws<System.ComponentModel.Win32Exception>(() => repository.ReplaceSourceFrom(
                "A.esp", [new TreeFile("plugin-source/A.esp/npc_/A.esp/000002.json", "{}"u8.ToArray())], "ABCDEF0123"));
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }

        var root = SourceRepository.RootIn(_modFolder, "A.esp");
        Assert.Equal(
            [Path.Combine(root, "npc_", "A.esp", "000001.json")],
            Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories));
    }
}
