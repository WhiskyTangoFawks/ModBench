using MEditService.Codec.Serialization;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryInitGitignoreTests
{
    private static readonly (IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin) Plugin = PluginBaselines.OneRecordOf("Test.esp");

    private static string[] CommittedPaths(string sourceFolder) =>
        GitProbe.Run(Path.Combine(sourceFolder, ".git"), sourceFolder, "ls-tree", "-r", "--name-only", "main")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries);

    private static bool Ignored(string sourceFolder, string path) =>
        GitProbe.TryRun(Path.Combine(sourceFolder, ".git"), sourceFolder, out _, "check-ignore", path);

    [Theory]
    [InlineData("Test.esp", true)]
    [InlineData("textures/new.dds", false)]
    [InlineData("build.json", false)]
    [InlineData("docs/build.json", true)]
    [InlineData("My-plugin-source/notes.txt", true)]
    public void APathLaterPut_IsTracked_OnlyAsTheBuildFile_UnderThePluginSource_OrInTheFolderOfAnAsset(string path, bool ignored)
    {
        using var sourceFolder = new ScratchDirectory("medit-init-gitignore-");
        TestAdapters.Source().Init(sourceFolder, SourceInits.BuildFile, [Plugin], [Asset("textures/a.dds")], commit: true);

        Assert.Equal(ignored, Ignored(sourceFolder, path));
    }

    private static FileToCopy Asset(string path) => new(path, () => new MemoryStream("asset"u8.ToArray()));

    [Fact]
    public void AnInitWithAManifest_CommitsItAtTheRoot_ThoughItsNameHoldsGlobCharacters_AndLeavesAFileTheManifestNamesIgnored()
    {
        using var sourceFolder = new ScratchDirectory("medit-init-gitignore-");
        File.WriteAllText(Path.Combine(sourceFolder, "assets.nif"), "a file a package yields");

        TestAdapters.Source().Init(
            sourceFolder, SourceInits.BuildFile, [Plugin], [], true, null, new RootFile("Mod [Patch] #1!.manifest.json", "{}"u8.ToArray()));

        Assert.Equal(
            [".gitattributes", ".gitignore", "Mod [Patch] #1!.manifest.json", "build.json", "plugin-source/Test.esp/npc_/Test.esp/000001.json"],
            CommittedPaths(sourceFolder));
    }

    [Fact]
    public void AnIgnoredPathInTheFolderOfAnAsset_IsIgnored_WhileTheAssetStaysTracked()
    {
        using var sourceFolder = new ScratchDirectory("medit-init-gitignore-");

        TestAdapters.Source().Init(
            sourceFolder, SourceInits.BuildFile, [Plugin], [Asset("textures/a.dds")], true, null,
            new RootFile("Mod.manifest.json", "{}"u8.ToArray()), ["textures/b [1].dds"]);

        Assert.True(Ignored(sourceFolder, "textures/b [1].dds"));
        Assert.False(Ignored(sourceFolder, "textures/a.dds"));
    }

}
