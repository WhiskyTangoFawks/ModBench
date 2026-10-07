using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>What a client is told when it puts a load order over trees Modbench has been writing: the plugins
/// whose binary is not the one Modbench last wrote.</summary>
internal static class ExternalChanges
{
    internal static IReadOnlyList<ChangedPlugin> NamedBy(LoadOrderSnapshot loadOrder)
    {
        var notifications = new InMemoryNotificationPublisher();
        var put = TestEditService.PutLoadOrderHandler(new LoadOrderHolder(), notifications).Put(
            loadOrder.DataFolderPath, loadOrder.InstanceRoot, loadOrder.GameRelease,
            loadOrder.Plugins, [.. loadOrder.Active.Select(p => p.Key)], [.. loadOrder.LoadedWithNoLine.Select(p => p.Key)]);
        Assert.True(put.Applied);
        return notifications.Notifications.OfType<ExternalChangeNotification>().SelectMany(notice => notice.Plugins).ToList();
    }
}
