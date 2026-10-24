using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.TestSupport;

/// <summary>Forwards every member to the real adapter so a double states only the verb it cares
/// about: these tests want real sources read with one seam intercepted, not a fake adapter.</summary>
public abstract class DelegatingSourceAdapter(ISourceAdapter inner) : ISourceAdapter
{
    public virtual ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release) => inner.TreeOf(plugin, release);

    public virtual ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) => inner.Over(plugin, release);

    public virtual bool SourceReads(RegisteredPlugin plugin) => inner.SourceReads(plugin);

    public virtual bool IsSourceMod(RegisteredPlugin plugin) => inner.IsSourceMod(plugin);

    public virtual bool IsSourceMod(string sourceFolder) => inner.IsSourceMod(sourceFolder);

    public virtual SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin) => inner.WhySourceDoesNotRead(plugin);

    public virtual ISourceRepository? Open(PluginProvider.FromMod provider, GameRelease release) => inner.Open(provider, release);

    public virtual ISourceRepository OverFolder(PluginProvider.FromMod provider, GameRelease release) => inner.OverFolder(provider, release);

    public virtual IWriteSession WriteSessionOver(PluginProvider.FromMod provider, GameRelease release, IReadOnlyList<DocumentChange> held) =>
        inner.WriteSessionOver(provider, release, held);

    public virtual bool TreeHolds(RegisteredPlugin plugin, string path) => inner.TreeHolds(plugin, path);

    public virtual RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path) => inner.RecordOfFile(loadOrder, path);

    public virtual string FileNameOf(RecordIdentity identity) => inner.FileNameOf(identity);

    public virtual bool HoldsAnotherRepository(string sourceFolder) => inner.HoldsAnotherRepository(sourceFolder);

    public virtual SourceFailure? WhyGitCannotRun() => inner.WhyGitCannotRun();


    public virtual string ContentStamp(string text) => inner.ContentStamp(text);

    public virtual SourceFailure? Init(
        string sourceFolder, string output, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins,
        IReadOnlyList<Asset> assets, (PluginAddress Plugin, TreeCommit Commit)? repair = null) =>
        inner.Init(sourceFolder, output, plugins, assets, repair);

    public virtual Answer<SourceToBuild, SourceFailure> SourceToBuild(string sourceFolder) => inner.SourceToBuild(sourceFolder);

    public virtual Answer<SubmoduleHead, SourceFailure> CommitAtHead(Submodule submodule, CancellationToken cancel) => inner.CommitAtHead(submodule, cancel);

    public virtual SourceFailure? ChangeBuildConfiguration(string sourceFolder, BuildConfigurationChange change) =>
        inner.ChangeBuildConfiguration(sourceFolder, change);

    public virtual IReadOnlyList<TreeFile> ReadBackOf(string pluginFileName, IReadOnlyList<TreeFile> tree, GameRelease gameRelease) =>
        inner.ReadBackOf(pluginFileName, tree, gameRelease);
}
