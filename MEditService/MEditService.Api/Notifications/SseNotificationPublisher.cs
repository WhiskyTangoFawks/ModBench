using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using MEditService.Core.Notifications;

namespace MEditService.Api.Notifications;

/// <summary>ADR-0046's first notification transport. A subscriber that falls behind is dropped: a
/// missed event is recoverable, an unbounded queue behind a stalled client is not.</summary>
public sealed class SseNotificationPublisher : INotificationPublisher
{
    private static readonly JsonSerializerOptions WireOptions = new(JsonSerializerDefaults.Web);

    private readonly ConcurrentDictionary<Guid, Channel<NotificationEvent>> _subscribers = new();

    public void Publish(Notification notification)
    {
        var wire = notification.ToEvent();
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
