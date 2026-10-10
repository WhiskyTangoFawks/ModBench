using MEditService.Ports;

namespace MEditService.TestSupport;

/// <summary>The notification port's second adapter: a plain recorder, so a test asserts the port
/// fired without a live HTTP stream. <see cref="OnPublish"/> runs before a notification is recorded,
/// and <see cref="FaultsOn"/> makes the publish throw instead.</summary>
public sealed class InMemoryNotificationPublisher : INotificationPublisher
{
    public const string FaultReason = "the stream could not take the push";

    private readonly object _gate = new();
    private readonly List<INotification> _notifications = [];

    public Action<INotification>? OnPublish { get; set; }

    public Predicate<INotification>? FaultsOn { get; set; }

    public void Publish(INotification notification)
    {
        if (FaultsOn?.Invoke(notification) == true) throw new InvalidOperationException(FaultReason);
        OnPublish?.Invoke(notification);
        lock (_gate) _notifications.Add(notification);
    }

    public IReadOnlyList<INotification> Notifications
    {
        get { lock (_gate) return [.. _notifications]; }
    }
}
