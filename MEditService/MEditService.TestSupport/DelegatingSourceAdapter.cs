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
    public virtual IReadOnlyList<string> PlacesHoldingPluginSourceOf(IReadOnlyList<PluginPlace> places, string pluginFileName) =>
        inner.PlacesHoldingPluginSourceOf(places, pluginFileName);

    public virtual bool IsSourceMod(RegisteredPlugin plugin) => inner.IsSourceMod(plugin);

    public virtual bool IsSourceMod(string sourceFolder) => inner.IsSourceMod(sourceFolder);

    public virtual SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin) => inner.WhySourceDoesNotRead(plugin);

    public virtual ISourceRepository? Open(PluginProvider.FromMod provider, GameRelease release) => inner.Open(provider, release);

    public virtual ISourceRepository OverFolder(PluginProvider.FromMod provider, GameRelease release) => inner.OverFolder(provider, release);

    public virtual IWriteSession WriteSessionOver(PluginProvider.FromMod provider, GameRelease release, IReadOnlyList<DocumentChange> held) =>
        inner.WriteSessionOver(provider, release, held);

    public virtual PathAnswer Touching(LoadOrderSnapshot loadOrder, string path) => inner.Touching(loadOrder, path);

    public void SignalChange(IReadOnlyCollection<PluginChange>? changes) => inner.SignalChange(changes);

    public event Action<IReadOnlyCollection<PluginChange>?>? ChangeSignalled
    {
        add => inner.ChangeSignalled += value;
        remove => inner.ChangeSignalled -= value;
    }

    public virtual RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path) => inner.RecordOfFile(loadOrder, path);

    public virtual string FileNameOf(RecordIdentity identity, GameRelease release) => inner.FileNameOf(identity, release);

    public virtual bool HoldsAnotherRepository(string sourceFolder) => inner.HoldsAnotherRepository(sourceFolder);

    public virtual SourceFailure? WhyGitCannotRun() => inner.WhyGitCannotRun();


    public virtual string ContentStamp(string text) => inner.ContentStamp(text);

    public virtual SourceFailure? Init(
        string sourceFolder, byte[] buildFile, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins,
        IReadOnlyList<FileToCopy> assets, bool commit, (PluginAddress Plugin, TreeCommit Commit)? repair, RootFile? manifest, IReadOnlyList<string> ignored,
        SourceModIn heldIn, ModFolderManifest? modFolderManifest) =>
        inner.Init(sourceFolder, buildFile, plugins, assets, commit, repair, manifest, ignored, heldIn, modFolderManifest);

    public virtual string TextOf(string sourceFolder, string path) => inner.TextOf(sourceFolder, path);

    public virtual string TextAt(string path) => inner.TextAt(path);

    public virtual string FileIn(string sourceFolder, string path) => inner.FileIn(sourceFolder, path);

    public virtual Answer<SourceToBuild, SourceFailure> SourceToBuild(string sourceFolder, IReadOnlyList<string> read) =>
        inner.SourceToBuild(sourceFolder, read);

    public virtual Answer<SubmoduleHead, SourceFailure> CommitAtHead(Submodule submodule, CancellationToken cancel) => inner.CommitAtHead(submodule, cancel);

    public virtual Answer<SourceChanges, SourceFailure> ChangesToMoveSourceFolder(string sourceFolder, string movedTo, IReadOnlyList<SourceMove> files) =>
        inner.ChangesToMoveSourceFolder(sourceFolder, movedTo, files);

    public virtual SourceFailure? FollowSourceFolderMove(string sourceFolder, string movedTo) => inner.FollowSourceFolderMove(sourceFolder, movedTo);
}
