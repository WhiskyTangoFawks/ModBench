using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
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
    public void EveryPristineFile_IsCommittedToMainWithItsExactBytes()
    {
        var relativePath = Path.Combine("plugin-source", "StillHere.esp", "npc_", "StillHere.esp", "000800.json");
        var content = "{\"formKey\":\"000800:StillHere.esp\"}"u8.ToArray();

        PluginBaselines.Init(_sourceFolder, [new TreeFile(relativePath, content)]);

        Assert.Equal("{\"formKey\":\"000800:StillHere.esp\"}", Git("show", $"main:{relativePath.Replace('\\', '/')}"));
    }

    [Fact]
    public void AnInit_IsOneCommitNamedForTheMod_HoldingEveryPluginsSourceTheAssetsAndTheBuildConfiguration()
    {
        TestAdapters.Source().Init(
            _sourceFolder, TestMod.Name, [OneRecordOf("A.esp"), OneRecordOf("B.esp")], [Asset("textures/a.dds", "texture")]);

        Assert.Equal([$"Init {TestMod.Name}"], SubjectsOnMain());
        Assert.Equal(
            [".gitignore", "assets/textures/a.dds", "build.json", "plugin-source/A.esp/npc_/A.esp/000001.json", "plugin-source/B.esp/npc_/B.esp/000001.json"],
            PathsIn("main"));
    }

    [Fact]
    public void ARepair_IsTheSecondCommit_HoldingOnlyThatPluginsRepairedTree()
    {
        var repaired = new TreeCommit([new TreeFile("npc_/A.esp/000001.json", "{\"repaired\":1}"u8.ToArray())], "Repair A.esp");

        Assert.Null(TestAdapters.Source().Init(_sourceFolder, TestMod.Name, [OneRecordOf("A.esp"), OneRecordOf("B.esp")], [], (A, repaired)));

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
            _sourceFolder, TestMod.Name, [OneRecordOf("A.esp")], [], (A, new TreeCommit(secondFileNeedsADirectoryTheFirstOccupies, "Repair A.esp"))));

        Assert.Empty(Directory.EnumerateFileSystemEntries(_sourceFolder));
    }

    [Fact]
    public void EachAsset_IsCommittedWithItsExactBytes()
    {
        byte[] bytes = [0x44, 0x44, 0x53, 0x20, 0x00, 0xFF, 0x0D, 0x0A];

        Assert.Null(TestAdapters.Source().Init(_sourceFolder, TestMod.Name, [], [new Asset("Textures/Sub Folder/a.dds", () => new MemoryStream(bytes))]));

        Assert.Equal(bytes, File.ReadAllBytes(Path.Combine(_sourceFolder, "assets", "Textures", "Sub Folder", "a.dds")));
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    [Fact]
    public void TheBuildConfiguration_NamesTheOutputFolder()
    {
        TestAdapters.Source().Init(_sourceFolder, "The Output", [OneRecordOf("A.esp")], []);

        Assert.Equal("{\n  \"output\": \"The Output\"\n}\n", Git("show", "main:build.json"));
    }

    [Fact]
    public void EachFile_KeepsItsLineEndingsAsWritten()
    {
        var crlf = "{\r\n  \"a\": 1\r\n}\r\n"u8.ToArray();
        var lf = "{\n  \"a\": 1\n}\n"u8.ToArray();

        PluginBaselines.Init(_sourceFolder,
            [new TreeFile("plugin-source/A.esp/npc_/A.esp/crlf.json", crlf), new TreeFile("plugin-source/A.esp/npc_/A.esp/lf.json", lf)]);

        Assert.Equal(crlf, File.ReadAllBytes(Path.Combine(_sourceFolder, "plugin-source", "A.esp", "npc_", "A.esp", "crlf.json")));
        Assert.Equal(Encoding.UTF8.GetString(crlf), Git("show", "main:plugin-source/A.esp/npc_/A.esp/crlf.json"));
        Assert.Equal(Encoding.UTF8.GetString(lf), Git("show", "main:plugin-source/A.esp/npc_/A.esp/lf.json"));
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    [Theory]
    [InlineData("First.esp")]
    [InlineData("Invented Plugin With Spaces.esp")]
    public void EachPluginsBinary_IsTheOneLastWrittenForThatPluginAlone(string first)
    {
        Assert.Null(TestAdapters.Source().Init(_sourceFolder, [OneRecordOf(first, "AAAA"), OneRecordOf("Second.esp", "BBBB")]));

        var repository = TestAdapters.Source().OverFolder(TestMod.In(_sourceFolder), GameRelease.Fallout4);
        Assert.Equal(["AAAA"], repository.LastWrittenBinarySha256s(new PluginAddress(first, TestMod.Name)).Value());
        Assert.Equal(["BBBB"], repository.LastWrittenBinarySha256s(new PluginAddress("Second.esp", TestMod.Name)).Value());
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

    private static readonly PluginAddress AnotherModsA = new("A.esp", "AnotherMod");

    [Fact]
    public void ADecompiledPluginAnotherModProvides_IsADefect_AndTheInitWritesNothing()
    {
        (IReadOnlyList<TreeFile>, DecompiledPlugin) anotherMods = (OneRecordOf("A.esp").Tree, new DecompiledPlugin(AnotherModsA, null));

        Assert.Throws<ArgumentException>(() => TestAdapters.Source().Init(_sourceFolder, [OneRecordOf("A.esp"), anotherMods]));

        Assert.Empty(Directory.EnumerateFileSystemEntries(_sourceFolder));
    }

    [Fact]
    public void ARepairOfAPluginAnotherModProvides_IsADefect_AndTheInitWritesNothing()
    {
        var repair = (AnotherModsA, new TreeCommit(OneRecordOf("A.esp").Tree, "Repair A.esp"));

        Assert.Throws<ArgumentException>(() => TestAdapters.Source().Init(_sourceFolder, TestMod.Name, [OneRecordOf("A.esp")], [], repair));

        Assert.Empty(Directory.EnumerateFileSystemEntries(_sourceFolder));
    }

    private static Asset Asset(string path, string text) => new(path, () => new MemoryStream(Encoding.UTF8.GetBytes(text)));

    private string[] SubjectsOnMain() =>
        Git("log", "--reverse", "--format=%s", "refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string[] PathsIn(string revision) =>
        Git("show", "--name-only", "--format=", revision).Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_sourceFolder, ".git"), _sourceFolder, args);
}
