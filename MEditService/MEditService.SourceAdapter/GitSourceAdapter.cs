using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>Reads each tree with <paramref name="unsaved"/>'s documents in place of their files.</summary>
public sealed class GitSourceAdapter(UnsavedDocuments unsaved) : ISourceAdapter
{
    public bool SourceReads(RegisteredPlugin plugin) => SourceRepository.SourceReads(plugin);

    public bool IsTracked(RegisteredPlugin plugin) => SourceRepository.IsTracked(plugin);

    public SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin) => SourceRepository.WhySourceDoesNotRead(plugin);

    public ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) =>
        plugin.Provider is PluginProvider.FromMod mod ? SourceRepository.Over(mod, release).Over(Files()) : null;

    public bool TreeHolds(RegisteredPlugin plugin, string path) => SourceRepository.TreeHolds(plugin, Path.GetFullPath(path));

    public RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path) =>
        SourceRepository.RecordOfFile(loadOrder, path, Files());

    public string FileNameOf(RecordIdentity identity) => SourceRepository.FileNameOf(identity);

    private UnsavedFiles Files() => new(unsaved.Current);
}
