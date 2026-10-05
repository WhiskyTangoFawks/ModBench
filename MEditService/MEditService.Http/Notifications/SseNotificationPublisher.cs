using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using MEditService.Ports;

namespace MEditService.Http.Notifications;

/// <summary>The notification port's transport adapter (ADR-0014). A subscriber that falls behind is dropped: a
/// missed event is recoverable, an unbounded queue behind a stalled client is not.</summary>
public sealed class SseNotificationPublisher : INotificationPublisher
{
    private static readonly JsonSerializerOptions WireOptions = new(JsonSerializerDefaults.Web);

    private readonly ConcurrentDictionary<Guid, Channel<NotificationEvent>> _subscribers = new();

    public void Publish(INotification notification)
    {
        var wire = NotificationEvent.From(notification);
        foreach (var (id, channel) in _subscribers)
        {
            if (!channel.Writer.TryWrite(wire)) _subscribers.TryRemove(id, out _);
        }
    }

    /// <summary>One subscriber's whole lifetime: an initial comment line confirms the connection is
    /// live before anything is published, then one SSE frame per notification until the client
    /// disconnects.</summary>
    public async Task StreamAsync(HttpResponse response, CancellationToken cancellationToken)
    {
        var id = Guid.NewGuid();
        var channel = Channel.CreateUnbounded<NotificationEvent>();
        _subscribers[id] = channel;
        try
        {
            response.ContentType = "text/event-stream";
            response.Headers.CacheControl = "no-cache";
            await response.StartAsync(cancellationToken);
            // Ignored by SSE, but its flush is what a caller waiting past just the headers
            // observes as "the subscription is open".
            await response.WriteAsync(": connected\n\n", cancellationToken);
            await response.Body.FlushAsync(cancellationToken);

            await foreach (var evt in channel.Reader.ReadAllAsync(cancellationToken))
            {
                var data = JsonSerializer.Serialize(evt, WireOptions);
                await response.WriteAsync($"event: {evt.Kind}\ndata: {data}\n\n", cancellationToken);
                await response.Body.FlushAsync(cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            // The client disconnected; nothing further to write.
        }
        finally
        {
            _subscribers.TryRemove(id, out _);
        }
    }
}

/// <summary>The one wire shape every notification kind serializes to. Kind is the SSE event name and the
/// discriminator; the trailing groups are null except for the one kind that fills them.</summary>
public sealed record NotificationEvent(
    string Kind, string Plugin, string Origin, IReadOnlyList<string> Keys, long Sequence,
    LoadOrderStatus? LoadOrderStatus = null,
    TrackProgress? TrackProgress = null,
    IReadOnlyList<ChangedPlugin>? ChangedPlugins = null)
{
    public static NotificationEvent From(INotification notification) => notification switch
    {
        RowsChangedNotification n => new("rows-changed", n.Plugin.Name, n.Plugin.Origin, n.Keys, n.Sequence),
        PluginChangedNotification n => new("plugin-changed", n.Plugin.Name, n.Plugin.Origin, [], n.Sequence),
        LoadOrderStatusNotification n => new("load-order-status", "", "", [], 0, LoadOrderStatus: n.Status),
        TrackProgressNotification n => new("track-progress", "", n.Progress.Mod ?? "", [], 0, TrackProgress: n.Progress),
        ExternalChangeNotification n => new("external-change", "", n.Origin, [], 0, ChangedPlugins: n.Plugins),
        UntrackedPluginsNotification n => new("untracked-plugins", "", n.Origin, n.Plugins, 0),
        _ => throw new ArgumentOutOfRangeException(nameof(notification), notification.GetType().Name, null),
    };
}
