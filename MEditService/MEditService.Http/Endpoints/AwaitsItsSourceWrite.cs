using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;

namespace MEditService.Http.Endpoints;

/// <summary>A gesture that writes ends when the read model shows it (commands.md): the route answers once the record
/// index has read the source writes the gesture made, and no read waits for one.</summary>
internal static class AwaitsItsSourceWrite
{
    internal static RouteHandlerBuilder AwaitingItsSourceWrite(this RouteHandlerBuilder route) =>
        route.AddEndpointFilter(async (context, next) =>
        {
            var written = context.HttpContext.RequestServices.GetRequiredService<LoadOrderHolder>();
            var before = written.SourceWrites;
            var result = await next(context).ConfigureAwait(false);
            if (result is not IStatusCodeHttpResult { StatusCode: >= 200 and < 300 }) return result;

            var queries = context.HttpContext.RequestServices.GetRequiredService<IQueries>();
            var unread = await queries.AwaitSourceWritesAfter(before, context.HttpContext.RequestAborted).ConfigureAwait(false);
            return unread is null ? result : EndpointMapping.Refusal(unread);
        });
}
