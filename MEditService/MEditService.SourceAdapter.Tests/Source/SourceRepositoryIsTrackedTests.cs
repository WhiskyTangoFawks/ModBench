using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryIsTrackedTests : IDisposable
{
    private static readonly PluginAddress PluginAt = new("Mine.esp", "Mod");

    private readonly ScratchDirectory _modFolder = new("medit-istracked-mod-");

    private readonly ScratchDirectory _sourceFolder = new("medit-istracked-source-");

    private RegisteredPlugin Registered => new(PluginAt.Name, PluginAt.Origin, "", new PluginProvider.FromMod("Mod", _modFolder, _sourceFolder), Line: null);

    public void Dispose()
    {
        _modFolder.Dispose();
        _sourceFolder.Dispose();
    }

    [Fact]
    public void IsTracked_PluginOfAModWhoseOwnFolderHoldsARepository_IsFalse()
    {
        CommitOnMain(_modFolder);

        Assert.False(TestAdapters.Source().IsTracked(Registered));
    }

    [Fact]
    public void SourceReads_TreeInTheModsOwnTrackedFolder_IsFalse()
    {
        CommitOnMain(_modFolder);
        MakeTree(_modFolder);

        Assert.False(TestAdapters.Source().SourceReads(Registered));
    }

    [Fact]
    public void IsTracked_FolderWithNoGitDirectory_IsFalse()
    {
        Assert.False(TestAdapters.Source().IsTracked(_sourceFolder));
    }

    [Fact]
    public void IsTracked_RepositoryWithNoMain_IsFalse()
    {
        Git(_sourceFolder, "init", "-q", "-b", "main");

        Assert.False(TestAdapters.Source().IsTracked(_sourceFolder));
    }

    [Fact]
    public void IsTracked_RepositoryWithMain_IsTrue()
    {
        CommitOnMain();

        Assert.True(TestAdapters.Source().IsTracked(_sourceFolder));
    }

    [Fact]
    public void IsTracked_RepositoryWhoseMainGitPacked_IsTrue()
    {
        CommitOnMain();
        Git(_sourceFolder, "pack-refs", "--all");

        Assert.True(TestAdapters.Source().IsTracked(_sourceFolder));
    }

    [Fact]
    public void IsTracked_FolderThatDoesNotExist_IsFalseNotAThrow()
    {
        Assert.False(TestAdapters.Source().IsTracked(Path.Combine(_sourceFolder, "Gone")));
    }

    [Fact]
    public void IsTracked_PluginOfATrackedMod_IsTrue()
    {
        CommitOnMain();

        Assert.True(TestAdapters.Source().IsTracked(Registered));
    }

    [Fact]
    public void IsTracked_PluginOfAModWithNoRepository_IsFalse()
    {
        Assert.False(TestAdapters.Source().IsTracked(Registered));
    }

    [Fact]
    public void IsTracked_PluginTheGameProvides_IsFalse()
    {
        Assert.False(TestAdapters.Source().IsTracked(Registered with { Provider = PluginProvider.Game }));
    }

    [Fact]
    public void SourceReads_TrackedModHoldingThePluginsTree_IsTrue()
    {
        CommitOnMain();
        MakeTree();

        Assert.True(TestAdapters.Source().SourceReads(Registered));
    }

    [Fact]
    public void SourceReads_TrackedModHoldingNoTreeForThePlugin_IsFalseThoughTracked()
    {
        CommitOnMain();

        Assert.True(TestAdapters.Source().IsTracked(Registered));
        Assert.False(TestAdapters.Source().SourceReads(Registered));
    }

    [Fact]
    public void SourceReads_TreeInAModThatIsNotTracked_IsFalse()
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
