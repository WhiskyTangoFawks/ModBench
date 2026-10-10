using MEditService.Index.Queries;
using MEditService.Ports;

namespace MEditService.Http.Endpoints;

/// <summary>The load order's status, sequence and record filter, and the index's rebuild, each one
/// Queries call and the wire translation of its answer (ADR-0014).</summary>
internal static class IndexEndpoints
{
    private const string LoadOrderTag = "LoadOrder";

    public static IEndpointRouteBuilder MapIndexEndpoints(this IEndpointRouteBuilder app)
    {
        // Polled alongside an in-flight PUT, so it answers 200 in every state including "no load
        // order yet" (ADR-0013). Reporting that absence is this route's job, not a failure.
        app.MapGet("/load-order/status", GetStatus)
            .WithName("GetLoadOrderStatus")
            .WithTags(LoadOrderTag)
            .Produces<LoadOrderStatus>();

        app.MapPost("/load-order/filter", SetFilter)
            .WithName("SetFilter")
            .WithTags(LoadOrderTag)
            .Produces<FilterResponse>()
            .ProducesProblem(400)
            .ProducesProblem(503)
            .ProducesProblem(500);

        app.MapDelete("/load-order/filter", ClearFilter)
            .WithName("ClearFilter")
            .WithTags(LoadOrderTag)
            .Produces(204)
            .ProducesProblem(500);

        app.MapGet("/load-order/filter", GetFilter)
            .WithName("GetFilter")
            .WithTags(LoadOrderTag)
            .Produces<FilterResponse>()
            .ProducesProblem(503);

        // The read side's sequence (ADR-0015). 0 with no index held, the same "absence is a state" answer
        // GetLoadOrderStatus gives.
        app.MapGet("/load-order/sequence", GetSequence)
            .WithName("GetSequence")
            .WithTags(LoadOrderTag)
            .Produces<long>();

        app.MapGet("/load-order/sequence/await", AwaitSequence)
            .WithName("AwaitSequence")
            .WithTags(LoadOrderTag)
            .Produces<SequenceAwaitResponse>()
            .ProducesProblem(400);

        // Refresh's own first step (ADR-0010). The PUT /load-order that follows is then an
        // ordinary cold load. Refuses exactly as PUT /load-order does when another window holds the
        // file.
        app.MapPost("/index/rebuild", PostRebuildIndex)
            .WithName("PostRebuildIndex")
            .WithTags(LoadOrderTag)
            .Produces(204)
            .ProducesProblem(400)
            .ProducesProblem(423)
            .ProducesProblem(500);

        return app;
    }

    // Deliberately not logged at Information like its neighbours: the Plugins tree polls this every
    // few hundred milliseconds for the duration of a reconcile, and one reception line per poll
    // would bury the per-plugin indexing lines it sits between.
    private static IResult GetStatus(IQueries svc, ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(IndexEndpoints)).LogTrace("Received GetLoadOrderStatus");
        return Results.Ok(svc.GetStatus());
    }

    private static IResult GetSequence(IQueries svc) => Results.Ok(svc.GetSequence());

    private static async Task<IResult> AwaitSequence(IQueries svc, long atLeast, int timeoutMs = 5000)
    {
        if (timeoutMs <= 0)
            return Results.Problem("timeoutMs must be positive.", statusCode: 400);

        return Results.Ok(await svc.AwaitSequence(atLeast, TimeSpan.FromMilliseconds(timeoutMs)));
    }

    private static IResult SetFilter(FilterRequest req, IQueries svc, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(IndexEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received SetFilter with {Sql}", req.Sql);
        }
        if (req.Sql is null)
            return Results.Problem("SQL is required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(req.Source))
            return Results.Problem("The filter's source is required.", statusCode: 400);
        return svc.SetFilter(req.Sql, req.Source) is { } refused
            ? EndpointMapping.Refusal(refused)
            : Results.Ok(new FilterResponse(req.Sql, req.Source));
    }

    private static IResult ClearFilter(IQueries svc, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(IndexEndpoints));
        logger.LogInformation("Received ClearFilter");
        svc.ClearFilter();
        return Results.NoContent();
    }

    private static IResult GetFilter(IQueries svc, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(IndexEndpoints));
        logger.LogInformation("Received GetFilter");
        return EndpointMapping.Answered(svc.GetFilter(), filter => Results.Ok(new FilterResponse(filter?.Sql, filter?.Source)));
    }

    private static IResult PostRebuildIndex(RebuildIndexRequest req, IQueries svc, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(IndexEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received PostRebuildIndex for {InstanceRoot}", req.InstanceRoot);
        }
        if (EndpointMapping.ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;

        // Answered once the store is empty again; the refill reports through the index status.
        return svc.RebuildStore(gameRelease, req.InstanceRoot) is { } refusal
            ? EndpointMapping.Refusal(refusal)
            : Results.NoContent();
    }
}
