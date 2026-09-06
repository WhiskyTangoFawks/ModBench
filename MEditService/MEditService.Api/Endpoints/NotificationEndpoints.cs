using MEditService.Api.Notifications;
using MEditService.Core.Notifications;

namespace MEditService.Api.Endpoints;

public static class NotificationEndpoints
{
    public static IEndpointRouteBuilder MapNotificationEndpoints(this IEndpointRouteBuilder app)
    {
        // ADR-0046: the notification port's first transport. Named SSE events ("rows-changed",
        // "plugin-changed"), each a NotificationEvent payload; stays open until the caller
        // disconnects.
        app.MapGet("/notifications/stream", (HttpContext ctx, SseNotificationPublisher stream) =>
            stream.StreamAsync(ctx.Response, ctx.RequestAborted))
        .WithName("StreamNotifications")
        .WithTags("Notifications")
        .Produces<NotificationEvent>(StatusCodes.Status200OK, "text/event-stream");

        return app;
    }
}
