using MEditService.Ports;

namespace MEditService.TestSupport;

/// <summary>The notification port's second adapter: a plain recorder, so a test asserts the port
/// fired without a live HTTP stream.</summary>
public sealed class InMemoryNotificationPublisher : INotificationPublisher
{
    private readonly object _gate = new();
    private readonly List<INotification> _notifications = [];

    public void Publish(INotification notification)
    {
        lock (_gate) _notifications.Add(notification);
    }

    public IReadOnlyList<INotification> Notifications
    {
        get { lock (_gate) return [.. _notifications]; }
    }
}
