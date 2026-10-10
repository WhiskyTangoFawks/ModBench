using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.SourceAdapter.Tests.TestSupport;

/// <summary>An exterior cell a test seeds, saved as the changes its repository answers.</summary>
internal static class SeedInWorldspace
{
    internal static void PutInWorldspace(this ISourceRepository repository, PluginAddress plugin, SourceDocument cell, string worldspace) =>
        repository.SaveChanges(repository.ChangesToPutInWorldspace(plugin, cell, worldspace)).Wrote();
}
