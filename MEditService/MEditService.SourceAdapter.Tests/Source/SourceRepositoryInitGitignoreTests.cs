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

    [Fact]
    public void AnInit_TracksExactlyTheGitignoreTheBuildFileThePluginSourceAndTheAssets()
    {
        using var sourceFolder = new ScratchDirectory("medit-init-gitignore-");

        TestAdapters.Source().Init(sourceFolder, SourceInits.BuildFile, [Plugin], [new Asset("meshes/a.nif", () => new MemoryStream("nif"u8.ToArray()))]);

        Assert.Equal(
            [".gitignore", "assets/meshes/a.nif", "build.json", "plugin-source/Test.esp/npc_/Test.esp/000001.json"],
            CommittedPaths(sourceFolder));
    }

    [Fact]
    public void AFileLaterPutBesideTheSource_IsIgnored_AndOneLaterPutAmongTheAssetsIsTracked()
    {
        using var sourceFolder = new ScratchDirectory("medit-init-gitignore-");
        TestAdapters.Source().Init(sourceFolder, SourceInits.BuildFile, [Plugin], []);
        File.WriteAllText(Path.Combine(sourceFolder, "Test.esp"), "a stray build output");
        Directory.CreateDirectory(Path.Combine(sourceFolder, "assets", "textures"));
        File.WriteAllText(Path.Combine(sourceFolder, "assets", "textures", "new.dds"), "a new asset");

        Assert.True(Ignored(sourceFolder, "Test.esp"));
        Assert.False(Ignored(sourceFolder, "assets/textures/new.dds"));
    }

    [Fact]
    public void TheBuildFile_IsTracked_AndOneOutsideTheRootIsNot()
    {
        using var sourceFolder = new ScratchDirectory("medit-init-gitignore-");
        TestAdapters.Source().Init(sourceFolder, SourceInits.BuildFile, [Plugin], []);

        Assert.False(Ignored(sourceFolder, "build.json"));
        Assert.True(Ignored(sourceFolder, "docs/build.json"));
    }

    [Fact]
    public void ATopLevelFolderThatMerelyEndsWithPluginSource_StaysIgnored_ForThePatternIsNotASuffixMatch()
    {
        using var sourceFolder = new ScratchDirectory("medit-init-gitignore-");
        TestAdapters.Source().Init(sourceFolder, SourceInits.BuildFile, [Plugin], []);
        Directory.CreateDirectory(Path.Combine(sourceFolder, "My-plugin-source"));
        File.WriteAllText(Path.Combine(sourceFolder, "My-plugin-source", "notes.txt"), "Notes");

        Assert.True(Ignored(sourceFolder, "My-plugin-source/notes.txt"));
    }

    [Fact]
    public void AnInitWithAManifest_CommitsItAtTheRoot_AndLeavesAFileTheManifestNamesIgnored()
    {
        using var sourceFolder = new ScratchDirectory("medit-init-gitignore-");
        File.WriteAllText(Path.Combine(sourceFolder, "assets.nif"), "a file a package yields");

        TestAdapters.Source().Init(
            sourceFolder, SourceInits.BuildFile, [Plugin], [], null, new RootFile("Mod.manifest.json", "{}"u8.ToArray()));

        Assert.Equal(
            [".gitignore", "Mod.manifest.json", "build.json", "plugin-source/Test.esp/npc_/Test.esp/000001.json"],
            CommittedPaths(sourceFolder));
    }
}
