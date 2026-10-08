using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

public sealed class GitSourceAdapter : ISourceAdapter
{
    public bool SourceReads(RegisteredPlugin plugin) => SourceRepository.SourceReads(plugin);

    public bool IsTracked(RegisteredPlugin plugin) => SourceRepository.IsTracked(plugin);

    public ISourceRepositoryReads Over(PluginProvider.FromMod provider, GameRelease release) => SourceRepository.Over(provider, release);
}
