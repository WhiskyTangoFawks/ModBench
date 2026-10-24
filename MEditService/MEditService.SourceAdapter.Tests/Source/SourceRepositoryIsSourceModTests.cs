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
    public void APluginOfAModWhoseOwnFolderRatherThanItsSourceFolderHoldsARepository_IsOfNoSourceMod()
    {
        CommitOnMain(_modFolder);

        Assert.False(TestAdapters.Source().IsSourceMod(Registered));
    }

    [Fact]
    public void ATreeInTheModsOwnFolderRatherThanItsSourceFolder_DoesNotRead()
    {
        CommitOnMain(_modFolder);
        MakeTree(_modFolder);

        Assert.False(TestAdapters.Source().SourceReads(Registered));
    }

    [Fact]
    public void AFolderWithNoGitDirectory_IsNoSourceMod()
    {
        Assert.False(TestAdapters.Source().IsSourceMod(_sourceFolder));
    }

    [Fact]
    public void ARepositoryWithNoMain_IsNoSourceMod()
    {
        Git(_sourceFolder, "init", "-q", "-b", "main");

        Assert.False(TestAdapters.Source().IsSourceMod(_sourceFolder));
    }

    [Fact]
    public void ARepositoryWithMain_IsASourceMod()
    {
        CommitOnMain();

        Assert.True(TestAdapters.Source().IsSourceMod(_sourceFolder));
    }

    [Fact]
    public void ARepositoryWhoseMainGitPacked_IsASourceMod()
    {
        CommitOnMain();
        Git(_sourceFolder, "pack-refs", "--all");

        Assert.True(TestAdapters.Source().IsSourceMod(_sourceFolder));
    }

    [Fact]
    public void AFolderThatDoesNotExist_IsNoSourceMod_NotAThrow()
    {
        Assert.False(TestAdapters.Source().IsSourceMod(Path.Combine(_sourceFolder, "Gone")));
    }

    [Fact]
    public void APluginOfAModWhoseSourceFolderHoldsARepository_IsOfASourceMod()
    {
        CommitOnMain();

        Assert.True(TestAdapters.Source().IsSourceMod(Registered));
    }

    [Fact]
    public void APluginOfAModWithNoRepository_IsOfNoSourceMod()
    {
        Assert.False(TestAdapters.Source().IsSourceMod(Registered));
    }

    [Fact]
    public void APluginTheGameProvides_IsOfNoSourceMod()
    {
        Assert.False(TestAdapters.Source().IsSourceMod(Registered with { Provider = PluginProvider.Game }));
    }

    [Fact]
    public void APluginsSource_ReadsFromASourceModHoldingItsTree()
    {
        CommitOnMain();
        MakeTree();

        Assert.True(TestAdapters.Source().SourceReads(Registered));
    }

    [Fact]
    public void APluginsSource_DoesNotReadFromASourceModHoldingNoTreeForIt()
    {
        CommitOnMain();

        Assert.True(TestAdapters.Source().IsSourceMod(Registered));
        Assert.False(TestAdapters.Source().SourceReads(Registered));
    }

    [Fact]
    public void ATreeInAModThatIsNoSourceMod_DoesNotRead()
    {
        MakeTree();

        Assert.False(TestAdapters.Source().SourceReads(Registered));
    }

    [Fact]
    public void TheSourceOfAPluginTheGameProvides_DoesNotRead()
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
