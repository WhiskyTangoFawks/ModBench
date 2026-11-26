using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryIsSourceModTests : IDisposable
{
    private static readonly PluginAddress PluginAt = new("Mine.esp", "Mod");

    private readonly ScratchDirectory _modFolder = new("medit-issourcemod-mod-");

    private readonly ScratchDirectory _sourceFolder = new("medit-issourcemod-source-");

    private RegisteredPlugin Registered => new(PluginAt.Name, PluginAt.Origin, "", new PluginProvider.FromMod("Mod", _modFolder, _sourceFolder), Line: null, PluginStrings.None);

    public void Dispose()
    {
        _modFolder.Dispose();
        _sourceFolder.Dispose();
    }

    public static TheoryData<string, Func<string, string>, bool> Folders => new()
    {
        { "no git directory", source => source, false },
        { "a repository with no main", source => Git(source, "init", "-q", "-b", "main"), false },
        { "a repository with main", CommitOnMain, true },
        { "a repository whose main git packed", source => Git(CommitOnMain(source), "pack-refs", "--all"), true },
        { "a repository with main but no build file", source => { File.Delete(Path.Combine(CommitOnMain(source), "build.json")); return source; }, false },
        { "a folder that does not exist", source => Path.Combine(source, "Gone"), false },
    };

    [Theory]
    [MemberData(nameof(Folders))]
    public void AFolder_IsASourceMod_OnlyWhenItsRepositoryHoldsMainAndTheBuildFile(string _, Func<string, string> made, bool isSourceMod)
    {
        Assert.Equal(isSourceMod, TestAdapters.Source().IsSourceMod(made(_sourceFolder)));
    }

    public static TheoryData<string, Action<string, string>, bool, bool> Plugins => new()
    {
        { "its source folder holds a repository and its tree", (_, source) => MakeTree(CommitOnMain(source)), true, true },
        { "its source folder holds a repository and no tree for it", (_, source) => CommitOnMain(source), true, false },
        { "its source folder holds a tree and no repository", (_, source) => MakeTree(source), false, false },
        { "its mod's own folder holds the repository and the tree", (mod, _) => MakeTree(CommitOnMain(mod)), false, false },
    };

    [Theory]
    [MemberData(nameof(Plugins))]
    public void APlugin_IsOfASourceMod_AndItsSourceReads_OnlyFromItsModsSourceFolder(
        string _, Action<string, string> made, bool isSourceMod, bool reads)
    {
        made(_modFolder, _sourceFolder);

        Assert.Equal((isSourceMod, reads), (TestAdapters.Source().IsSourceMod(Registered), TestAdapters.Source().SourceReads(Registered)));
    }

    [Fact]
    public void APluginTheGameProvides_IsOfNoSourceMod_AndItsSourceDoesNotRead()
    {
        MakeTree(CommitOnMain(_sourceFolder));
        var plugin = Registered with { Provider = PluginProvider.Game };

        Assert.Equal((false, false), (TestAdapters.Source().IsSourceMod(plugin), TestAdapters.Source().SourceReads(plugin)));
    }

    private static void MakeTree(string folder) => Directory.CreateDirectory(Path.Combine(folder, "plugin-source", PluginAt.Name));

    private static string CommitOnMain(string folder)
    {
        File.WriteAllText(Path.Combine(folder, "build.json"), "{}");
        Git(folder, "init", "-q", "-b", "main");
        return Git(folder, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "--allow-empty", "-m", "First");
    }

    private static string Git(string folder, params string[] args)
    {
        GitProbe.Run(Path.Combine(folder, ".git"), folder, args);
        return folder;
    }
}
