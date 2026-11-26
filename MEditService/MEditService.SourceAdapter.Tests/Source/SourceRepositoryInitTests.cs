using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using static MEditService.SourceAdapter.Tests.TestSupport.PluginBaselines;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryInitTests : IDisposable
{
    private readonly ScratchDirectory _root = new("medit-init-");
    private readonly string _sourceFolder;

    public SourceRepositoryInitTests() => _sourceFolder = Directory.CreateDirectory(Path.Combine(_root, TestMod.Name)).FullName;

    public void Dispose() => _root.Dispose();

    private static readonly PluginAddress A = new("A.esp", TestMod.Name);

    [Fact]
    public void AnInit_IsOneCommitNamedForTheMod_HoldingEveryPluginsSourceTheAssetsAndTheBuildFile()
    {
        TestAdapters.Source().Init(
            _sourceFolder, SourceInits.BuildFile, [OneRecordOf("A.esp"), OneRecordOf("B.esp")], [Asset("textures/a.dds", "texture"), Asset("readme.txt", "readme")], commit: true);

        Assert.Equal([$"Init {TestMod.Name}"], SubjectsOnMain());
        Assert.Equal(
            [".gitattributes", ".gitignore", "build.json", "plugin-source/A.esp/npc_/A.esp/000001.json", "plugin-source/B.esp/npc_/B.esp/000001.json", "readme.txt", "textures/a.dds"],
            PathsIn("main"));
        Assert.Equal("the build file", Git("show", "main:build.json"));
    }

    [Fact]
    public void ARepair_IsTheSecondCommit_HoldingOnlyThatPluginsRepairedTree()
    {
        var repaired = new TreeCommit([new TreeFile("npc_/A.esp/000001.json", "{\"repaired\":1}"u8.ToArray())], "Repair A.esp");

        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.BuildFile, [OneRecordOf("A.esp"), OneRecordOf("B.esp")], [], true, (A, repaired)));

        Assert.Equal([$"Init {TestMod.Name}", "Repair A.esp"], SubjectsOnMain());
        Assert.Equal(["plugin-source/A.esp/npc_/A.esp/000001.json"], PathsIn("main"));
        Assert.Equal("{\"repaired\":1}", Git("show", "main:plugin-source/A.esp/npc_/A.esp/000001.json"));
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    [Fact]
    public void AnInitWhoseRepairCommitFails_LeavesNoRepositoryAndNoFile()
    {
        TreeFile[] secondFileNeedsADirectoryTheFirstOccupies = [new("npc_", "{}"u8.ToArray()), new("npc_/A.esp/000002.json", "{}"u8.ToArray())];

        Assert.NotNull(TestAdapters.Source().Init(
            _sourceFolder, SourceInits.BuildFile, [OneRecordOf("A.esp")], [], true, (A, new TreeCommit(secondFileNeedsADirectoryTheFirstOccupies, "Repair A.esp"))));

        Assert.Empty(Directory.EnumerateFileSystemEntries(_sourceFolder));
    }

    [Fact]
    public void AModWithNoFiles_InitsInASourceFolderThatDoesNotExistYet()
    {
        Directory.Delete(_sourceFolder);

        Assert.Null(TestAdapters.Source().Init(_sourceFolder, SourceInits.BuildFile, [], [], commit: true));

        Assert.Equal([".gitattributes", ".gitignore", "build.json"], PathsIn("main"));
    }

    [Fact]
    public void AnInit_LeavesMainCheckedOut_WithNothingUncommitted()
    {
        TestAdapters.Source().Init(_sourceFolder, [OneRecordOf("A.esp"), OneRecordOf("B.esp")]);

        Assert.Equal(["main"], Git("branch", "--format=%(refname:short)").Split('\n', StringSplitOptions.RemoveEmptyEntries));
        Assert.Equal("main", Git("symbolic-ref", "--short", "HEAD").Trim());
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    [Fact]
    public void AnInitIntoAModThatAlreadyHasARepository_IsADefect_AndChangesNothingOfIt()
    {
        TestAdapters.Source().Init(_sourceFolder, [OneRecordOf("A.esp")]);
        var mainBefore = Git("rev-parse", "refs/heads/main");

        Assert.Throws<InvalidOperationException>(() => TestAdapters.Source().Init(_sourceFolder, [OneRecordOf("B.esp")]));

        Assert.Equal(mainBefore, Git("rev-parse", "refs/heads/main"));
        Assert.False(Directory.Exists(Path.Combine(_sourceFolder, "plugin-source", "B.esp")));
    }

    private static FileToCopy Asset(string path, string text) => new(path, () => new MemoryStream(Encoding.UTF8.GetBytes(text)));

    private string[] SubjectsOnMain() =>
        Git("log", "--reverse", "--format=%s", "refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string[] PathsIn(string revision) =>
        Git("show", "--name-only", "--format=", revision).Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_sourceFolder, ".git"), _sourceFolder, args);
}
