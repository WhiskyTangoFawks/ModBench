using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>What a client is told when it puts a load order over trees Modbench has been writing, then signals a change:
/// the plugins whose binary is not the one Modbench last wrote.</summary>
internal static class ExternalChanges
{
    internal static IReadOnlyList<ChangedPlugin> NamedBy(LoadOrderSnapshot loadOrder)
    {
        var notifications = new InMemoryNotificationPublisher();
        var service = TestEditService.Over(new LoadOrderHolder(), notifications: notifications);
        Put(loadOrder, service.GetRequiredService<PutLoadOrderHandler>());
        service.GetRequiredService<SignalChangeHandler>().Signal([]);
        return notifications.Notifications.OfType<ExternalChangeNotification>().SelectMany(notice => notice.Plugins).ToList();
    }

    internal static void Put(LoadOrderSnapshot loadOrder, PutLoadOrderHandler handler) =>
        Assert.True(handler.Put(
            loadOrder.DataFolderPath, loadOrder.InstanceRoot, loadOrder.GameRelease,
            loadOrder.Plugins, [.. loadOrder.Active.Select(p => p.Key)], [.. loadOrder.LoadedWithNoLine.Select(p => p.Key)], loadOrder.Archives, loadOrder.StringsFiles,
            loadOrder.Places, loadOrder.StringsLanguage, loadOrder.ListedArchives).Holds(out _, out _));
}
