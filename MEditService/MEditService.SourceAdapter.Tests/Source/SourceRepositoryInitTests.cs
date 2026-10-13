using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryInitTests : IDisposable
{
    private readonly ScratchDirectory _root = new("medit-init-");
    private readonly string _sourceFolder;

    public SourceRepositoryInitTests() => _sourceFolder = Directory.CreateDirectory(Path.Combine(_root, TestMod.Name)).FullName;

    public void Dispose() => _root.Dispose();

    [Fact]
    public void Init_CommitsEveryPristineFileToMain_WithItsExactBytes()
    {
        var relativePath = Path.Combine("plugin-source", "StillHere.esp", "npc_", "StillHere.esp", "000800.json");
        var content = "{\"formKey\":\"000800:StillHere.esp\"}"u8.ToArray();

        PluginBaselines.Init(_sourceFolder, [new TreeFile(relativePath, content)]);

        Assert.Equal("{\"formKey\":\"000800:StillHere.esp\"}", Git("show", $"main:{relativePath.Replace('\\', '/')}"));
    }

    [Fact]
    public void Init_MakesOneCommitNamedForTheMod_HoldingEveryPluginsSourceTheAssetsAndTheBuildConfiguration()
    {
        TestAdapters.Source().Init(
            _sourceFolder, TestMod.Name, [DoorTreeOf("A.esp"), DoorTreeOf("B.esp")], [Asset("textures/a.dds", "texture")]);

        Assert.Equal([$"Init {TestMod.Name}"], SubjectsOnMain());
        Assert.Equal(
            [".gitignore", "assets/textures/a.dds", "build.json", "plugin-source/A.esp/npc_/A.esp/000001.json", "plugin-source/B.esp/npc_/B.esp/000001.json"],
            PathsIn("main"));
    }

    [Fact]
    public void Init_CommitsEachAssetWithItsExactBytes()
    {
        byte[] bytes = [0x44, 0x44, 0x53, 0x20, 0x00, 0xFF, 0x0D, 0x0A];

        Assert.Null(TestAdapters.Source().Init(_sourceFolder, TestMod.Name, [], [new Asset("Textures/Sub Folder/a.dds", () => new MemoryStream(bytes))]));

        Assert.Equal(bytes, File.ReadAllBytes(Path.Combine(_sourceFolder, "assets", "Textures", "Sub Folder", "a.dds")));
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    [Fact]
    public void Init_WritesABuildConfigurationThatNamesTheOutputFolder()
    {
        TestAdapters.Source().Init(_sourceFolder, "The Output", [DoorTreeOf("A.esp")], []);

        Assert.Equal("{\n  \"output\": \"The Output\"\n}\n", Git("show", "main:build.json"));
    }

    [Fact]
    public void Init_KeepsEachFilesLineEndingsAsWritten()
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

    [Fact]
    public void Init_ParksEachPluginsBinaryOnItsOwnRef()
    {
        TestAdapters.Source().Init(
            _sourceFolder, TestMod.Name,
            [
                (SourceOf("First.esp"), new DecompiledPlugin("First.esp", "AAAA")),
                (SourceOf("Second.esp"), new DecompiledPlugin("Second.esp", "BBBB")),
            ],
            []);

        var repository = TestAdapters.Source().OverFolder(TestMod.In(_sourceFolder), GameRelease.Fallout4);
        Assert.Equal(["AAAA"], repository.LastWrittenBinarySha256s(new PluginAddress("First.esp", TestMod.Name)).Value());
        Assert.Equal(["BBBB"], repository.LastWrittenBinarySha256s(new PluginAddress("Second.esp", TestMod.Name)).Value());
    }

    [Fact]
    public void Init_LeavesMainCheckedOut_WithNothingUncommitted()
    {
        PluginBaselines.Init(_sourceFolder, [.. SourceOf("A.esp"), .. SourceOf("B.esp")]);

        Assert.Equal(["main"], Git("branch", "--format=%(refname:short)").Split('\n', StringSplitOptions.RemoveEmptyEntries));
        Assert.Equal("main", Git("symbolic-ref", "--short", "HEAD").Trim());
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    [Fact]
    public void Init_IntoAModThatAlreadyHasARepository_ThrowsAndChangesNothingOfIt()
    {
        PluginBaselines.Init(_sourceFolder, SourceOf("A.esp"));
        var mainBefore = Git("rev-parse", "refs/heads/main");

        Assert.Throws<InvalidOperationException>(() => PluginBaselines.Init(_sourceFolder, SourceOf("B.esp")));

        Assert.Equal(mainBefore, Git("rev-parse", "refs/heads/main"));
        Assert.False(Directory.Exists(Path.Combine(_sourceFolder, "plugin-source", "B.esp")));
    }

    private static Asset Asset(string path, string text) => new(path, () => new MemoryStream(Encoding.UTF8.GetBytes(text)));

    private static (IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin) DoorTreeOf(string plugin) =>
        ([new TreeFile($"npc_/{plugin}/000001.json", "{}"u8.ToArray())], new DecompiledPlugin(plugin, null));

    private static List<TreeFile> SourceOf(string plugin) =>
        [new TreeFile($"plugin-source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())];

    private string[] SubjectsOnMain() =>
        Git("log", "--reverse", "--format=%s", "refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string[] PathsIn(string revision) =>
        Git("show", "--name-only", "--format=", revision).Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_sourceFolder, ".git"), _sourceFolder, args);
}
