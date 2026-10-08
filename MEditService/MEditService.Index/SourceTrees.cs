using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Index;

internal static class SourceTrees
{
    /// <summary>The reads over <paramref name="plugin"/>'s source tree; null when it has none that reads.</summary>
    internal static ISourceRepositoryReads? TreeOf(this ISourceAdapter source, RegisteredPlugin plugin, GameRelease release) =>
        source.SourceReads(plugin) ? source.Over(plugin, release) : null;
}
