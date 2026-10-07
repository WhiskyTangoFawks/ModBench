using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryAnswersTests : IDisposable
{
    private static readonly PluginAddress Plugin = new("Mine.esp", "Mod");

    private readonly ScratchDirectory _modFolder = new("medit-answers-");

    public void Dispose() => _modFolder.Dispose();

    private PluginProvider Provider => new PluginProvider.FromMod("Mod", _modFolder);

    [Fact]
    public void IsTracked_ModFolderHoldingTheRepository_IsTrue()
    {
        CommitOnMain();

        Assert.True(SourceRepository.IsTracked(Provider));
    }

    [Fact]
    public void IsTracked_ModFolderWithNoRepository_IsFalse()
    {
        Assert.False(SourceRepository.IsTracked(Provider));
    }

    [Fact]
    public void IsTracked_PluginTheGameProvides_IsFalse()
    {
        Assert.False(SourceRepository.IsTracked(PluginProvider.Game));
    }

    [Fact]
    public void SourceReads_TrackedModHoldingThePluginsTree_IsTrue()
    {
        CommitOnMain();
        Directory.CreateDirectory(Path.Combine(_modFolder, "plugin-source", Plugin.Name));

        Assert.True(SourceRepository.SourceReads(Plugin, Provider));
    }

    [Fact]
    public void SourceReads_TrackedModHoldingNoTreeForThePlugin_IsFalseThoughTracked()
    {
        CommitOnMain();

        Assert.True(SourceRepository.IsTracked(Provider));
        Assert.False(SourceRepository.SourceReads(Plugin, Provider));
    }

    [Fact]
    public void SourceReads_TreeInAFolderThatIsNotTracked_IsFalse()
    {
        Directory.CreateDirectory(Path.Combine(_modFolder, "plugin-source", Plugin.Name));

        Assert.False(SourceRepository.SourceReads(Plugin, Provider));
    }

    [Fact]
    public void SourceReads_PluginTheGameProvides_IsFalse()
    {
        Assert.False(SourceRepository.SourceReads(Plugin, PluginProvider.Game));
    }

    private void CommitOnMain()
    {
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, "init", "-q", "-b", "main");
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder,
            "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-q", "--allow-empty", "-m", "First");
    }
}
