using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.Index.Queries;

public sealed class PluginExtensionsQueryService(LoadOrderHolder loadOrder)
{
    public Answer<IReadOnlyList<string>, IndexRefused> GetCreatable() =>
        IndexAnswer.Of(() => CreatablePluginExtensions.Of(loadOrder.Require().GameRelease));
}
