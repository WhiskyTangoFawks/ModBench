using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The git source adapter, but asked whether git can run it answers no, as when git leaves the PATH after
/// the verb that last ran it.</summary>
internal sealed class GitGoneSourceAdapter : ISourceAdapter
{
    private readonly ISourceAdapter _inner = TestAdapters.Source();
    private readonly SourceFailure _gitMissing;

    /// <summary>Changes the process's PATH while it reads the failure, so its caller holds the process environment.</summary>
    internal GitGoneSourceAdapter()
    {
        var path = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            _gitMissing = _inner.WhyGitCannotRun() ?? throw new InvalidOperationException("Expected git to be missing with no PATH.");
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }
    }

    public SourceFailure? WhyGitCannotRun() => _gitMissing;

    public bool SourceReads(RegisteredPlugin plugin) => _inner.SourceReads(plugin);

    public bool IsSourceMod(RegisteredPlugin plugin) => _inner.IsSourceMod(plugin);

    public bool IsSourceMod(string sourceFolder) => _inner.IsSourceMod(sourceFolder);

    public SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin) => _inner.WhySourceDoesNotRead(plugin);

    public ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) => _inner.Over(plugin, release);

    public ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release) => _inner.TreeOf(plugin, release);

    public ISourceRepository? Open(PluginProvider.FromMod provider, GameRelease release) => _inner.Open(provider, release);

    public ISourceRepository OverFolder(PluginProvider.FromMod provider, GameRelease release) => _inner.OverFolder(provider, release);

    public IWriteSession WriteSessionOver(PluginProvider.FromMod provider, GameRelease release, IReadOnlyList<DocumentChange> held) =>
        _inner.WriteSessionOver(provider, release, held);

    public bool TreeHolds(RegisteredPlugin plugin, string path) => _inner.TreeHolds(plugin, path);

    public RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path) => _inner.RecordOfFile(loadOrder, path);

    public string FileNameOf(RecordIdentity identity) => _inner.FileNameOf(identity);

    public bool HoldsAnotherRepository(string sourceFolder) => _inner.HoldsAnotherRepository(sourceFolder);


    public string ContentStamp(string text) => _inner.ContentStamp(text);

    public SourceFailure? Init(
        string sourceFolder, string output, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins,
        IReadOnlyList<Asset> assets, (PluginAddress Plugin, TreeCommit Commit)? repair = null) =>
        _inner.Init(sourceFolder, output, plugins, assets, repair);

    public Answer<SourceToBuild, SourceFailure> SourceToBuild(string sourceFolder) => _inner.SourceToBuild(sourceFolder);

    public Answer<SubmoduleHead, SourceFailure> CommitAtHead(Submodule submodule, CancellationToken cancel) => _inner.CommitAtHead(submodule, cancel);

    public SourceFailure? ChangeBuildConfiguration(string sourceFolder, BuildConfigurationChange change) =>
        _inner.ChangeBuildConfiguration(sourceFolder, change);

    public IReadOnlyList<TreeFile> ReadBackOf(string pluginFileName, IReadOnlyList<TreeFile> tree, GameRelease gameRelease) =>
        _inner.ReadBackOf(pluginFileName, tree, gameRelease);
}
