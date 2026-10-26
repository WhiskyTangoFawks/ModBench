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
    public void AnInit_TracksExactlyTheGitignoreTheManifestThePluginSourceAndTheAssets()
    {
        using var sourceFolder = new ScratchDirectory("medit-init-gitignore-");

        TestAdapters.Source().Init(sourceFolder, SourceInits.ManifestOf("Mod"), [Plugin], [new Asset("meshes/a.nif", () => new MemoryStream("nif"u8.ToArray()))]);

        Assert.Equal(
            [".gitignore", "Mod.manifest.json", "assets/meshes/a.nif", "plugin-source/Test.esp/npc_/Test.esp/000001.json"],
            CommittedPaths(sourceFolder));
    }

    [Fact]
    public void AFileLaterPutBesideTheSource_IsIgnored_AndOneLaterPutAmongTheAssetsIsTracked()
    {
        using var sourceFolder = new ScratchDirectory("medit-init-gitignore-");
        TestAdapters.Source().Init(sourceFolder, SourceInits.ManifestOf("Mod"), [Plugin], []);
        File.WriteAllText(Path.Combine(sourceFolder, "Test.esp"), "a stray build output");
        Directory.CreateDirectory(Path.Combine(sourceFolder, "assets", "textures"));
        File.WriteAllText(Path.Combine(sourceFolder, "assets", "textures", "new.dds"), "a new asset");

        Assert.True(Ignored(sourceFolder, "Test.esp"));
        Assert.False(Ignored(sourceFolder, "assets/textures/new.dds"));
    }

    [Fact]
    public void AManifestNamedForAnotherOutput_IsTracked_AndOneOutsideTheRootIsNot()
    {
        using var sourceFolder = new ScratchDirectory("medit-init-gitignore-");
        TestAdapters.Source().Init(sourceFolder, SourceInits.ManifestOf("Mod"), [Plugin], []);

        Assert.False(Ignored(sourceFolder, "Renamed.manifest.json"));
        Assert.True(Ignored(sourceFolder, "docs/Renamed.manifest.json"));
    }

    [Fact]
    public void ATopLevelFolderThatMerelyEndsWithPluginSource_StaysIgnored_ForThePatternIsNotASuffixMatch()
    {
        using var sourceFolder = new ScratchDirectory("medit-init-gitignore-");
        TestAdapters.Source().Init(sourceFolder, SourceInits.ManifestOf("Mod"), [Plugin], []);
        Directory.CreateDirectory(Path.Combine(sourceFolder, "My-plugin-source"));
        File.WriteAllText(Path.Combine(sourceFolder, "My-plugin-source", "notes.txt"), "Notes");

        Assert.True(Ignored(sourceFolder, "My-plugin-source/notes.txt"));
    }
}
