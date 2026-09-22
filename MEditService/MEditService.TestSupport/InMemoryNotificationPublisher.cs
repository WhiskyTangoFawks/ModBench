using MEditService.Ports;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.TestSupport.TestSupport;

/// <summary>One published notification as its wire event reads, for a suite whose box draws no
/// arrow to the ports and so names no notification type.</summary>
public sealed record PublishedNotification(
    string Kind, string Plugin, string Origin, IReadOnlyList<string> Keys,
    IReadOnlyList<string> TrackedFiles, bool? MetaChanged, string? OldVersion, string? NewVersion,
    string? CrashRepairReason);

/// <summary>The notification port's second adapter: a plain recorder, so a test asserts the port
/// fired without a live HTTP stream.</summary>
public sealed class InMemoryNotificationPublisher : INotificationPublisher
{
    private readonly object _gate = new();
    private readonly List<Notification> _notifications = [];

    public void Publish(Notification notification)
    {
        lock (_gate) _notifications.Add(notification);
    }

    public IReadOnlyList<Notification> Notifications
    {
        get { lock (_gate) return [.. _notifications]; }
    }

    public IReadOnlyList<PublishedNotification> Published =>
        [.. Notifications.Select(n => n.ToEvent()).Select(e => new PublishedNotification(
            e.Kind, e.Plugin, e.Origin, e.Keys, e.ExternalChangeTrackedFiles ?? [],
            e.ExternalChangeMetaChanged, e.ExternalChangeOldVersion, e.ExternalChangeNewVersion, e.CrashRepairReason))];

    /// <summary>Registers this recorder as the port, for a suite composing a box's handlers without
    /// naming the port's type.</summary>
    public IServiceCollection RegisterIn(IServiceCollection services) =>
        services.AddSingleton<INotificationPublisher>(this);
}
