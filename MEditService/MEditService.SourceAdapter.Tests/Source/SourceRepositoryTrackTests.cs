using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryTrackTests : IDisposable
{
    private const string ModName = "SomeMod";
    private readonly ScratchDirectory _root = new("medit-track-");
    private readonly string _modFolder;

    public SourceRepositoryTrackTests() => _modFolder = Directory.CreateDirectory(Path.Combine(_root, ModName)).FullName;

    public void Dispose() => _root.Dispose();

    [Fact]
    public void Track_CommitsEveryPristineFileToMain_WithItsExactBytes()
    {
        var relativePath = Path.Combine("plugin-source", "StillHere.esp", "npc_", "StillHere.esp", "000800.json");
        var content = "{\"formKey\":\"000800:StillHere.esp\"}"u8.ToArray();

        PluginBaselines.Track(_modFolder, [new TreeFile(relativePath, content)]);

        Assert.Equal("{\"formKey\":\"000800:StillHere.esp\"}", Git("show", $"main:{relativePath.Replace('\\', '/')}"));
    }

    [Fact]
    public void Track_MakesOneCommitNamedForTheMod_HoldingEveryPluginsSource()
    {
        PluginBaselines.Track(_modFolder, [.. SourceOf("A.esp"), .. SourceOf("B.esp")]);

        Assert.Equal(["Track SomeMod"], SubjectsOnMain());
        Assert.Equal(
            [".gitignore", "plugin-source/A.esp/npc_/A.esp/000001.json", "plugin-source/B.esp/npc_/B.esp/000001.json"],
            PathsIn("main"));
    }

    [Fact]
    public void Track_KeepsEachFilesLineEndingsAsWritten()
    {
        var crlf = "{\r\n  \"a\": 1\r\n}\r\n"u8.ToArray();
        var lf = "{\n  \"a\": 1\n}\n"u8.ToArray();

        PluginBaselines.Track(_modFolder,
            [new TreeFile("plugin-source/A.esp/npc_/A.esp/crlf.json", crlf), new TreeFile("plugin-source/A.esp/npc_/A.esp/lf.json", lf)]);

        Assert.Equal(crlf, File.ReadAllBytes(Path.Combine(_modFolder, "plugin-source", "A.esp", "npc_", "A.esp", "crlf.json")));
        Assert.Equal(Encoding.UTF8.GetString(crlf), Git("show", "main:plugin-source/A.esp/npc_/A.esp/crlf.json"));
        Assert.Equal(Encoding.UTF8.GetString(lf), Git("show", "main:plugin-source/A.esp/npc_/A.esp/lf.json"));
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    [Fact]
    public void Track_ParksEachPluginsBinaryOnItsOwnRef()
    {
        SourceRepository.Track(
            _modFolder,
            [
                (SourceOf("First.esp"), new DecompiledPlugin("First.esp", "AAAA")),
                (SourceOf("Second.esp"), new DecompiledPlugin("Second.esp", "BBBB")),
            ]);

        var repository = SourceRepository.Over(_modFolder, GameRelease.Fallout4);
        Assert.Equal(["AAAA"], repository.LastWrittenBinarySha256s(new PluginAddress("First.esp", ModName)));
        Assert.Equal(["BBBB"], repository.LastWrittenBinarySha256s(new PluginAddress("Second.esp", ModName)));
    }

    [Fact]
    public void Track_LeavesMainCheckedOut_WithNothingUncommitted()
    {
        PluginBaselines.Track(_modFolder, [.. SourceOf("A.esp"), .. SourceOf("B.esp")]);

        Assert.Equal(["main"], Git("branch", "--format=%(refname:short)").Split('\n', StringSplitOptions.RemoveEmptyEntries));
        Assert.Equal("main", Git("symbolic-ref", "--short", "HEAD").Trim());
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    [Fact]
    public void Track_IntoAModThatAlreadyHasARepository_ThrowsAndChangesNothingOfIt()
    {
        PluginBaselines.Track(_modFolder, SourceOf("A.esp"));
        var mainBefore = Git("rev-parse", "refs/heads/main");

        Assert.Throws<InvalidOperationException>(() => PluginBaselines.Track(_modFolder, SourceOf("B.esp")));

        Assert.Equal(mainBefore, Git("rev-parse", "refs/heads/main"));
        Assert.False(Directory.Exists(Path.Combine(_modFolder, "plugin-source", "B.esp")));
    }

    private static List<TreeFile> SourceOf(string plugin) =>
        [new TreeFile($"plugin-source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())];

    private string[] SubjectsOnMain() =>
        Git("log", "--reverse", "--format=%s", "refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string[] PathsIn(string revision) =>
        Git("show", "--name-only", "--format=", revision).Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
