using MEditService.Codec.Schema;
using MEditService.LoadOrder;

namespace MEditService.Queries;

public sealed class PluginExtensionsQueryService(LoadOrderHolder loadOrder)
{
    public IReadOnlyList<string> GetCreatable() => CreatablePluginExtensions.Of(loadOrder.Require().GameRelease);
}
