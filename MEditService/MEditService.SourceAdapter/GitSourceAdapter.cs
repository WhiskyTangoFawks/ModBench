using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>Reads each tree with <paramref name="unsaved"/>'s documents in place of their files.</summary>
public sealed class GitSourceAdapter(UnsavedDocuments unsaved) : ISourceAdapter
{
    public bool SourceReads(RegisteredPlugin plugin) => SourceRepository.SourceReads(plugin);

    public bool IsTracked(RegisteredPlugin plugin) => SourceRepository.IsTracked(plugin);

    public bool IsTracked(string modFolder) => SourceRepository.IsTracked(modFolder);

    public SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin) => SourceRepository.WhySourceDoesNotRead(plugin);

    public ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) =>
        plugin.Provider is PluginProvider.FromMod mod ? SourceRepository.Over(mod, release).Over(Files()) : null;

    public ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release) =>
        SourceReads(plugin) ? Over(plugin, release) : null;

    public ISourceRepository? Open(PluginProvider.FromMod provider, GameRelease release) => SourceRepository.Open(provider, release);

    public ISourceRepository OverFolder(PluginProvider.FromMod provider, GameRelease release) => SourceRepository.Over(provider, release);

    public IWriteSession WriteSessionOver(PluginProvider.FromMod provider, GameRelease release, IReadOnlyList<DocumentChange> held) =>
        WriteSession.Over(provider, release, held);

    public bool TreeHolds(RegisteredPlugin plugin, string path) => SourceRepository.TreeHolds(plugin, Path.GetFullPath(path));

    public RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path) =>
        SourceRepository.RecordOfFile(loadOrder, path, Files());

    public string FileNameOf(RecordIdentity identity) => SourceRepository.FileNameOf(identity);

    public bool HoldsAnotherRepository(string modFolder) => SourceRepository.HoldsAnotherRepository(modFolder);

    public SourceFailure? WhyGitCannotRun() => SourceRepository.WhyGitCannotRun();

    public string? InstanceRootNotFound(string? instanceRoot) => SourceRepository.InstanceRootNotFound(instanceRoot);

    public IReadOnlyList<(string Plugin, string Reason)> Track(
        string modFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins) =>
        SourceRepository.Track(modFolder, plugins);

    public IReadOnlyList<TreeFile> ReadBackOf(string pluginFileName, IReadOnlyList<TreeFile> tree, GameRelease gameRelease) =>
        SourceRepository.ReadBackOf(pluginFileName, tree, gameRelease);

    private UnsavedFiles Files() => new(unsaved.Current);
}
