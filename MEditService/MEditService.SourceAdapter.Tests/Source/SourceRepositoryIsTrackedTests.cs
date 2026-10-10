using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryIsTrackedTests : IDisposable
{
    private static readonly PluginAddress PluginAt = new("Mine.esp", "Mod");

    private readonly ScratchDirectory _modFolder = new("medit-istracked-");

    private RegisteredPlugin Registered => new(PluginAt.Name, PluginAt.Origin, "", new PluginProvider.FromMod("Mod", _modFolder), Line: null);

    public void Dispose() => _modFolder.Dispose();

    [Fact]
    public void IsTracked_FolderWithNoGitDirectory_IsFalse()
    {
        Assert.False(TestAdapters.Source().IsTracked(_modFolder));
    }

    [Fact]
    public void IsTracked_RepositoryWithNoMain_IsFalse()
    {
        Git("init", "-q", "-b", "main");

        Assert.False(TestAdapters.Source().IsTracked(_modFolder));
    }

    [Fact]
    public void IsTracked_RepositoryWithMain_IsTrue()
    {
        CommitOnMain();

        Assert.True(TestAdapters.Source().IsTracked(_modFolder));
    }

    [Fact]
    public void IsTracked_RepositoryWhoseMainGitPacked_IsTrue()
    {
        CommitOnMain();
        Git("pack-refs", "--all");

        Assert.True(TestAdapters.Source().IsTracked(_modFolder));
    }

    [Fact]
    public void IsTracked_FolderThatDoesNotExist_IsFalseNotAThrow()
    {
        Assert.False(TestAdapters.Source().IsTracked(Path.Combine(_modFolder, "Gone")));
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

    private void MakeTree() => Directory.CreateDirectory(Path.Combine(_modFolder, "plugin-source", PluginAt.Name));

    private void CommitOnMain()
    {
        Git("init", "-q", "-b", "main");
        Git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "--allow-empty", "-m", "First");
    }

    private void Git(params string[] args) => GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);
}
