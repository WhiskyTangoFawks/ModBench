using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>Reads each tree with <paramref name="unsaved"/>'s documents in place of their files, and settles a file's
/// stamp by <paramref name="time"/>.</summary>
public sealed class GitSourceAdapter(UnsavedDocuments unsaved, TimeProvider time) : ISourceAdapter
{
    private readonly TreeStamps _stamps = new(time);

    public bool SourceReads(RegisteredPlugin plugin) => SourceRepository.SourceReads(plugin);

    public bool IsSourceMod(RegisteredPlugin plugin) => SourceRepository.IsSourceMod(plugin);

    public bool IsSourceMod(string sourceFolder) => SourceRepository.IsSourceMod(sourceFolder);

    public SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin) => SourceRepository.WhySourceDoesNotRead(plugin);

    public ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) =>
        plugin.Provider is PluginProvider.FromMod { SourceFolder: not null } mod ? SourceRepository.Over(mod, release, _stamps).Over(Files()) : null;

    public ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release) =>
        SourceReads(plugin) ? Over(plugin, release) : null;

    public ISourceRepository? Open(PluginProvider.FromMod provider, GameRelease release) => SourceRepository.Open(provider, release, _stamps);

    public ISourceRepository OverFolder(PluginProvider.FromMod provider, GameRelease release) => SourceRepository.Over(provider, release, _stamps);

    public IWriteSession WriteSessionOver(PluginProvider.FromMod provider, GameRelease release, IReadOnlyList<DocumentChange> held) =>
        WriteSession.Over(provider, release, held, _stamps);

    public bool TreeHolds(RegisteredPlugin plugin, string path) => SourceRepository.TreeHolds(plugin, Path.GetFullPath(path));

    public RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path) =>
        SourceRepository.RecordOfFile(loadOrder, path, Files(), _stamps);

    public string FileNameOf(RecordIdentity identity) => SourceRepository.FileNameOf(identity);

    public bool HoldsAnotherRepository(string sourceFolder) => SourceRepository.HoldsAnotherRepository(sourceFolder);

    public SourceFailure? WhyGitCannotRun() => SourceRepository.WhyGitCannotRun();

    public string ContentStamp(string text) => TreeStamps.ContentStamp(text);

    public SourceFailure? Init(
        string sourceFolder, string output, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins,
        IReadOnlyList<Asset> assets, (PluginAddress Plugin, TreeCommit Commit)? repair = null) =>
        SourceFailure.Answer(() => GitInit.Init(sourceFolder, output, plugins, assets, repair));

    public Answer<SourceToBuild, SourceFailure> SourceToBuild(string sourceFolder) =>
        SourceFailure.Answer(() => BuildConfiguration.ToBuild(sourceFolder));

    public Answer<SubmoduleHead, SourceFailure> CommitAtHead(Submodule submodule, CancellationToken cancel) =>
        SourceFailure.Answer(() => Submodules.CommitAtHead(submodule, cancel));

    public SourceFailure? ChangeBuildConfiguration(string sourceFolder, BuildConfigurationChange change) =>
        SourceFailure.Answer(() => BuildConfiguration.Change(sourceFolder, change));

    public IReadOnlyList<TreeFile> ReadBackOf(string pluginFileName, IReadOnlyList<TreeFile> tree, GameRelease gameRelease) =>
        SourceRepository.ReadBackOf(pluginFileName, tree, gameRelease);

    private UnsavedFiles Files() => new(unsaved.Current);
}
