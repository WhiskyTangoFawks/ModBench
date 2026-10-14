using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.TestSupport;

internal enum TreeMoment { StampsTaken, ReadBegins, ReadEnds, RecordRead, TreeAsked }

/// <summary>The Git source adapter, calling <c>at</c> at each moment of a tree's read.</summary>
internal sealed class HookedSource(Action<TreeMoment, PluginAddress> at) : ISourceAdapter
{
    private readonly ISourceAdapter _inner = new GitSourceAdapter(new UnsavedDocuments());

    public ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) =>
        _inner.Over(plugin, release) is { } reads ? new HookedRepository(reads, at) : null;

    public ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release) =>
        _inner.SourceReads(plugin) ? Over(plugin, release) : null;

    public bool SourceReads(RegisteredPlugin plugin) => _inner.SourceReads(plugin);

    public bool IsTracked(RegisteredPlugin plugin) => _inner.IsTracked(plugin);

    public bool IsTracked(string modFolder) => _inner.IsTracked(modFolder);

    public SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin) => _inner.WhySourceDoesNotRead(plugin);

    public ISourceRepository? Open(PluginProvider.FromMod provider, GameRelease release) => _inner.Open(provider, release);

    public ISourceRepository OverFolder(PluginProvider.FromMod provider, GameRelease release) => _inner.OverFolder(provider, release);

    public IWriteSession WriteSessionOver(PluginProvider.FromMod provider, GameRelease release, IReadOnlyList<DocumentChange> held) =>
        _inner.WriteSessionOver(provider, release, held);

    public event Action<IReadOnlyList<string>>? Wrote
    {
        add => _inner.Wrote += value;
        remove => _inner.Wrote -= value;
    }

    public bool TreeHolds(RegisteredPlugin plugin, string path)
    {
        at(TreeMoment.TreeAsked, plugin.Key);
        return _inner.TreeHolds(plugin, path);
    }

    public RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path) => _inner.RecordOfFile(loadOrder, path);

    public string FileNameOf(RecordIdentity identity) => _inner.FileNameOf(identity);

    public bool HoldsAnotherRepository(string modFolder) => _inner.HoldsAnotherRepository(modFolder);

    public SourceFailure? WhyGitCannotRun() => _inner.WhyGitCannotRun();

    public string? InstanceRootNotFound(string? instanceRoot) => _inner.InstanceRootNotFound(instanceRoot);

    public SourceFailure? Init(
        string sourceFolder, string output, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins,
        IReadOnlyList<Asset> assets) =>
        _inner.Init(sourceFolder, output, plugins, assets);

    public Answer<SourceToBuild, SourceFailure> SourceToBuild(string sourceFolder) => _inner.SourceToBuild(sourceFolder);

    public SourceFailure? ChangeBuildConfiguration(string sourceFolder, BuildConfigurationChange change) =>
        _inner.ChangeBuildConfiguration(sourceFolder, change);

    public IReadOnlyList<TreeFile> ReadBackOf(string pluginFileName, IReadOnlyList<TreeFile> tree, GameRelease gameRelease) =>
        _inner.ReadBackOf(pluginFileName, tree, gameRelease);
}

internal sealed class HookedRepository(ISourceRepositoryReads inner, Action<TreeMoment, PluginAddress> at) : ISourceRepositoryReads
{
    public RecordStamps StampsOf(PluginAddress plugin)
    {
        var stamps = inner.StampsOf(plugin);
        at(TreeMoment.StampsTaken, plugin);
        return stamps;
    }

    public Answer<T, SourceFailure> ReadDocuments<T>(PluginAddress plugin, Func<IPluginDocuments, T> read)
    {
        at(TreeMoment.ReadBegins, plugin);
        try
        {
            return inner.ReadDocuments(plugin, read);
        }
        finally
        {
            at(TreeMoment.ReadEnds, plugin);
        }
    }

    public Answer<SourceDocument?, SourceFailure> RecordOf(PluginAddress plugin, RecordIdentity identity)
    {
        at(TreeMoment.RecordRead, plugin);
        return inner.RecordOf(plugin, identity);
    }

    public Answer<IReadOnlyDictionary<string, RecordChange>, SourceFailure> ChangedSinceLastCommit(PluginAddress plugin) =>
        inner.ChangedSinceLastCommit(plugin);

    public SourceFailure? WhyUnreadable(PluginAddress plugin, RecordIdentity identity, string body) =>
        inner.WhyUnreadable(plugin, identity, body);

    public Answer<SourceDocument?, SourceFailure> RecordFromText(PluginAddress plugin, string formKey, string text) =>
        inner.RecordFromText(plugin, formKey, text);

    public Answer<DocumentFile?, SourceFailure> DocumentOf(PluginAddress plugin, RecordIdentity identity) => inner.DocumentOf(plugin, identity);

    public Answer<string?, SourceFailure> RelativePathOf(PluginAddress plugin, RecordIdentity identity) => inner.RelativePathOf(plugin, identity);

    public Answer<string?, SourceFailure> FileNameOf(PluginAddress plugin, RecordIdentity identity) => inner.FileNameOf(plugin, identity);
}
