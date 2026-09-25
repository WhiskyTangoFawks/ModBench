using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Against a real git repo in a scratch mod folder, never a mocked git (ADR-0007).</summary>
public sealed class SourceRepositoryTrackTests : IDisposable
{
    private const string ModName = "SomeMod";
    private readonly string _root = Directory.CreateTempSubdirectory("medit-track-").FullName;
    private readonly string _modFolder;

    public SourceRepositoryTrackTests() => _modFolder = Directory.CreateDirectory(Path.Combine(_root, ModName)).FullName;

    public void Dispose() => Directory.Delete(_root, recursive: true);

    [Fact]
    public void Track_CommitsEveryPristineFileToMain_WithItsExactBytes()
    {
        var relativePath = Path.Combine("source", "StillHere.esp", "npc_", "StillHere.esp", "000800.json");
        var content = "{\"formKey\":\"000800:StillHere.esp\"}"u8.ToArray();

        PluginBaselines.Track(_modFolder, SourcePreset.Edits, [new TreeFile(relativePath, content)]);

        Assert.Equal("{\"formKey\":\"000800:StillHere.esp\"}", Git("show", $"main:{relativePath.Replace('\\', '/')}"));
    }

    [Fact]
    public void Track_WithNoUpstreamVersion_LeavesItOutOfTheSubjectAndTheTrailers()
    {
        SourceRepository.Track(
            _modFolder, SourcePreset.Edits,
            [(SourceOf("Test.esp"), new BaselineTrailers("Test.esp", UpstreamVersion: null, MetaSha256: null, BinarySha256: "ABCDEF0123"))]);

        Assert.Equal("Track Test.esp", Git("log", "-1", "--format=%s", "main").Trim());
        Assert.Equal("Plugin: Test.esp\nBinary-SHA256: ABCDEF0123", Git("log", "-1", "--format=%(trailers:only,unfold)", "main").Trim());
    }

    [Fact]
    public void Track_CommitsEachPluginsSourceOnlyInItsOwnBaseline()
    {
        PluginBaselines.Track(_modFolder, SourcePreset.Edits, [.. SourceOf("A.esp"), .. SourceOf("B.esp")]);

        Assert.Equal([".gitignore"], PathsIn("main~2"));
        Assert.Equal(["source/A.esp/npc_/A.esp/000001.json"], PathsIn("main~1"));
        Assert.Equal(["source/B.esp/npc_/B.esp/000001.json"], PathsIn("main"));
    }

    [Fact]
    public void Track_UnderEverything_CommitsTheModsAssetsInTheModsOwnCommit()
    {
        Directory.CreateDirectory(Path.Combine(_modFolder, "Textures"));
        File.WriteAllText(Path.Combine(_modFolder, "Textures", "Thing.dds"), "pixels");

        PluginBaselines.Track(_modFolder, SourcePreset.Everything, SourceOf("A.esp"));

        Assert.Equal("Track SomeMod", Git("log", "-1", "--format=%s", "main~1").Trim());
        Assert.Equal([".gitignore", "Textures/Thing.dds"], PathsIn("main~1"));
        Assert.Equal(["source/A.esp/npc_/A.esp/000001.json"], PathsIn("main"));
    }

    [Fact]
    public void Track_LeavesNothingUncommitted_OnTheEditBranch()
    {
        PluginBaselines.Track(_modFolder, SourcePreset.Edits, [.. SourceOf("A.esp"), .. SourceOf("B.esp")]);

        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    [Fact]
    public void Track_IntoAModThatAlreadyHasARepository_AddsOneBaselineCommit_AndLeavesTheEditBranchWhereItWas()
    {
        PluginBaselines.Track(_modFolder, SourcePreset.Edits, SourceOf("A.esp"));
        var mainBefore = Git("rev-parse", "refs/heads/main");
        var editBefore = Git("rev-parse", "refs/heads/edit");

        PluginBaselines.Track(_modFolder, SourcePreset.Edits, SourceOf("B.esp"));

        Assert.Equal(["Track SomeMod", "Track A.esp", "Track B.esp"], SubjectsOnMain());
        Assert.Equal(mainBefore, Git("rev-parse", "refs/heads/main~1"));
        Assert.Equal(["source/B.esp/npc_/B.esp/000001.json"], PathsIn("main"));
        Assert.Equal(Git("rev-parse", "refs/heads/main"), Git("rev-parse", SourceRepository.LastCompileRef("B.esp")));
        Assert.Equal(editBefore, Git("rev-parse", "refs/heads/edit"));
        Assert.Equal("edit", Git("symbolic-ref", "--short", "HEAD").Trim());
        Assert.Equal(string.Empty, Git("status", "--porcelain"));
    }

    private static List<TreeFile> SourceOf(string plugin) =>
        [new TreeFile($"source/{plugin}/npc_/{plugin}/000001.json", "{}"u8.ToArray())];

    private string[] SubjectsOnMain() =>
        Git("log", "--reverse", "--format=%s", "refs/heads/main").Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string[] PathsIn(string revision) =>
        Git("show", "--name-only", "--format=", revision).Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private string Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
