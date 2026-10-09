using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

public sealed class GitSourceAdapter : ISourceAdapter
{
    public bool SourceReads(RegisteredPlugin plugin) => SourceRepository.SourceReads(plugin);

    public bool IsTracked(RegisteredPlugin plugin) => SourceRepository.IsTracked(plugin);

    public SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin) => SourceRepository.WhySourceDoesNotRead(plugin);

    public ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) =>
        plugin.Provider is PluginProvider.FromMod mod ? SourceRepository.Over(mod, release) : null;

    public RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path) => SourceRepository.RecordOfFile(loadOrder, path);

    public string FileNameOf(RecordIdentity identity) => SourceRepository.FileNameOf(identity);
}
