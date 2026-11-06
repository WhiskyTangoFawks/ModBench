using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class ChangedPathTests : IDisposable
{
    private readonly ScratchDirectory _instance = new("medit-changed-path-");

    public ChangedPathTests()
    {
        var mod = SourceFolderOf("Mod");
        RepositoryAt(Path.Combine(mod, ".git"), mod);
        PinnedAsASubmodule(SourceFolderOf("Pinned"), Directory.CreateDirectory(Path.Combine(_instance, ".git", "modules", "Pinned")).FullName);
    }

    public void Dispose() => _instance.Dispose();

    private string SourceFolderOf(string mod)
    {
        var folder = Directory.CreateDirectory(Path.Combine(_instance, "source", mod)).FullName;
        File.WriteAllText(Path.Combine(folder, "build.json"), "{}");
        Directory.CreateDirectory(Path.Combine(folder, "plugin-source", $"{mod}.esp"));
        return folder;
    }

    private static void PinnedAsASubmodule(string sourceFolder, string gitDir)
    {
        RepositoryAt(gitDir, sourceFolder);
        File.WriteAllText(Path.Combine(sourceFolder, ".git"), $"gitdir: {Path.GetRelativePath(sourceFolder, gitDir)}\n");
    }

    private static void RepositoryAt(string gitDir, string workTree)
    {
        GitProbe.Run(gitDir, workTree, "init", "-q", "-b", "main");
        GitProbe.Run(gitDir, workTree, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "--allow-empty", "-m", "First");
    }

    private LoadOrderSnapshot LoadOrder => SnapshotPlugins.Snapshot(_instance, _instance, GameRelease.Fallout4,
        [.. new[] { "Mod", "Pinned" }.Select((mod, line) => new LoadOrderEntry(
            $"{mod}.esp", Path.Combine(_instance, "mods", mod, $"{mod}.esp"), mod, line, Enabled: true, Winning: true,
            NamedProvider: new PluginProvider.FromMod(mod, Path.Combine(_instance, "mods", mod), Path.Combine(_instance, "source", mod))))]);

    [Theory]
    [InlineData("source/Mod/plugin-source/Mod.esp/Npcs/Npc.json", "Mod.esp")]
    [InlineData("source/Mod/build.json", "unnamed")]
    [InlineData("source/Mod/.git/refs/heads/main", "unnamed")]
    [InlineData("source/Mod/plugin-source/Other.esp/Npcs/Npc.json", "unnamed")]
    [InlineData("source/Mod/textures/mod.dds", "untouched")]
    [InlineData("source/Pinned/.git", "unnamed")]
    [InlineData(".git/modules/Pinned/refs/heads/main", "unnamed")]
    [InlineData(".git/modules/Other/HEAD", "untouched")]
    [InlineData("mods/Mod/Mod.esp", "untouched")]
    public void APath_TouchesThePluginsWhosePluginSourceHoldsIt_OrPluginsItCannotNameForWhatASourceModBuildsFrom(string path, string answer)
    {
        Assert.Equal(answer, PathAnswers.Spelled(TestAdapters.Source().Touching(LoadOrder, Path.Combine(_instance, path))));
    }
}
