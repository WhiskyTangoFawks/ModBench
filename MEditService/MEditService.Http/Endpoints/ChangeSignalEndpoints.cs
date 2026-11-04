using MEditService.Commands;

namespace MEditService.Http.Endpoints;

internal static class ChangeSignalEndpoints
{
    public static IEndpointRouteBuilder MapChangeSignalEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/signal-change", SignalChange)
            .WithName("SignalChange")
            .WithTags("LoadOrder")
            .WithDescription(
                "Says that the disk changed, naming no path, so mEdit checks it (ADR-0015). Answers once the compiled plugins " +
                "of the load order held are checked for a change made outside Modbench, published as external-change; the " +
                "record index validates every plugin after, and announces what it re-read.")
            .Produces(204);

        return app;
    }

    internal static IResult SignalChange(SignalChangeHandler handler)
    {
        handler.Signal();
        return Results.NoContent();
    }
}
