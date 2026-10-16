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

    [Fact]
    public void IsSourceMod_PluginOfAModWhoseOwnFolderHoldsARepository_IsFalse()
    {
        CommitOnMain(_modFolder);

        Assert.False(TestAdapters.Source().IsSourceMod(Registered));
    }

    [Fact]
    public void SourceReads_TreeInTheModsOwnSourceModFolder_IsFalse()
    {
        CommitOnMain(_modFolder);
        MakeTree(_modFolder);

        Assert.False(TestAdapters.Source().SourceReads(Registered));
    }

    [Fact]
    public void IsSourceMod_FolderWithNoGitDirectory_IsFalse()
    {
        Assert.False(TestAdapters.Source().IsSourceMod(_sourceFolder));
    }

    [Fact]
    public void IsSourceMod_RepositoryWithNoMain_IsFalse()
    {
        Git(_sourceFolder, "init", "-q", "-b", "main");

        Assert.False(TestAdapters.Source().IsSourceMod(_sourceFolder));
    }

    [Fact]
    public void IsSourceMod_RepositoryWithMain_IsTrue()
    {
        CommitOnMain();

        Assert.True(TestAdapters.Source().IsSourceMod(_sourceFolder));
    }

    [Fact]
    public void IsSourceMod_RepositoryWhoseMainGitPacked_IsTrue()
    {
        CommitOnMain();
        Git(_sourceFolder, "pack-refs", "--all");

        Assert.True(TestAdapters.Source().IsSourceMod(_sourceFolder));
    }

    [Fact]
    public void IsSourceMod_FolderThatDoesNotExist_IsFalseNotAThrow()
    {
        Assert.False(TestAdapters.Source().IsSourceMod(Path.Combine(_sourceFolder, "Gone")));
    }

    [Fact]
    public void IsSourceMod_PluginOfASourceMod_IsTrue()
    {
        CommitOnMain();

        Assert.True(TestAdapters.Source().IsSourceMod(Registered));
    }

    [Fact]
    public void IsSourceMod_PluginOfAModWithNoRepository_IsFalse()
    {
        Assert.False(TestAdapters.Source().IsSourceMod(Registered));
    }

    [Fact]
    public void IsSourceMod_PluginTheGameProvides_IsFalse()
    {
        Assert.False(TestAdapters.Source().IsSourceMod(Registered with { Provider = PluginProvider.Game }));
    }

    [Fact]
    public void SourceReads_SourceModHoldingThePluginsTree_IsTrue()
    {
        CommitOnMain();
        MakeTree();

        Assert.True(TestAdapters.Source().SourceReads(Registered));
    }

    [Fact]
    public void SourceReads_SourceModHoldingNoTreeForThePlugin_IsFalseThoughSourceMod()
    {
        CommitOnMain();

        Assert.True(TestAdapters.Source().IsSourceMod(Registered));
        Assert.False(TestAdapters.Source().SourceReads(Registered));
    }

    [Fact]
    public void SourceReads_TreeInAModThatIsNotSourceMod_IsFalse()
    {
        MakeTree();

        Assert.False(TestAdapters.Source().SourceReads(Registered));
    }

    [Fact]
    public void SourceReads_PluginTheGameProvides_IsFalse()
    {
        Assert.False(TestAdapters.Source().SourceReads(Registered with { Provider = PluginProvider.Game }));
    }

    private void MakeTree(string? folder = null) => Directory.CreateDirectory(Path.Combine(folder ?? _sourceFolder, "plugin-source", PluginAt.Name));

    private void CommitOnMain(string? folder = null)
    {
        Git(folder ?? _sourceFolder, "init", "-q", "-b", "main");
        Git(folder ?? _sourceFolder, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "--allow-empty", "-m", "First");
    }

    private static void Git(string folder, params string[] args) => GitProbe.Run(Path.Combine(folder, ".git"), folder, args);
}
