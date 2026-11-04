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
                "Says that the disk changed at the paths named, or, naming none, that mEdit is to check it (ADR-0015). A path that " +
                "the record index reads for plugins mEdit cannot name, such as a build file or an archive, checks the disk; one it reads " +
                "nothing of is dropped. Answers once the mods of the plugins whose files are touched, or every mod at a check, are " +
                "checked for a change made outside Modbench, published as external-change; the record index validates the plugins " +
                "touched, or every plugin, after, and announces what it re-read.")
            .Produces(204);

        return app;
    }

    internal static IResult SignalChange(SignalChangeRequest? request, SignalChangeHandler handler)
    {
        handler.Signal(request?.Paths ?? []);
        return Results.NoContent();
    }
}

/// <summary>Paths are the absolute paths of the files the watch saw change.</summary>
internal sealed record SignalChangeRequest(IReadOnlyList<string>? Paths);
