using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>What mEdit holds when a client puts a load order over trees Modbench has been writing, then signals a change:
/// the plugins whose binary is not the one Modbench last wrote.</summary>
internal static class ExternalChanges
{
    internal static IReadOnlyList<PluginAddress> NamedBy(LoadOrderSnapshot loadOrder)
    {
        var service = TestEditService.Over(new LoadOrderHolder());
        Put(loadOrder, service.GetRequiredService<PutLoadOrderHandler>());
        service.GetRequiredService<SignalChangeHandler>().Signal([]);
        var changed = service.GetRequiredService<IQueries>().Handed();
        return [.. loadOrder.Plugins.Select(plugin => plugin.Origin).Distinct().SelectMany(origin => changed.ChangedOutside(origin).Select(name => new PluginAddress(name, origin)))];
    }

    internal static void Put(LoadOrderSnapshot loadOrder, PutLoadOrderHandler handler) =>
        Assert.True(handler.Put(
            loadOrder.DataFolderPath, loadOrder.InstanceRoot, loadOrder.GameRelease,
            loadOrder.Plugins, [.. loadOrder.Active.Select(p => p.Key)], [.. loadOrder.LoadedWithNoLine.Select(p => p.Key)], loadOrder.Archives, loadOrder.StringsFiles,
            loadOrder.Places, loadOrder.StringsLanguage, loadOrder.ListedArchives).Holds(out _, out _));
}
