using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;

namespace MEditService.Http.Endpoints;

/// <summary>A gesture that writes ends when the read model shows it (commands.md). A write that landed answers its
/// outcome even when the index is late; the index's status says so.</summary>
internal static class AwaitsItsSourceWrite
{
    internal static RouteHandlerBuilder AwaitingItsSourceWrite(this RouteHandlerBuilder route) =>
        route.AddEndpointFilter(async (context, next) =>
        {
            var services = context.HttpContext.RequestServices;
            var own = services.GetRequiredService<LoadOrderHolder>().BeginOwnWrites();
            var result = await next(context).ConfigureAwait(false);
            if (own.Snapshot().Count == 0) return result;

            var unread = await services.GetRequiredService<IQueries>()
                .AwaitSourceWrites(own, context.HttpContext.RequestAborted).ConfigureAwait(false);
            if (unread is not null)
            {
                services.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(AwaitsItsSourceWrite))
                    .LogWarning("A write landed that the record index has not read: {Message}", unread.Message);
            }
            return result;
        });
}
