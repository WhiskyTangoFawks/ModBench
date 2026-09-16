using MEditService.Commands;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using Mutagen.Bethesda;

namespace MEditService.Http.Endpoints;

public static class LoadOrderEndpoints
{
    private const string Tag = "LoadOrder";

    public static IEndpointRouteBuilder MapLoadOrderEndpoints(this IEndpointRouteBuilder app)
    {
        // ADR-0013: the one way the load order reaches Editing. PUT, because it is state, not a
        // command: sending the same body twice changes nothing.
        app.MapPut("/load-order", PutLoadOrder)
            .WithName("PutLoadOrder")
            .WithTags(Tag)
            .WithDescription(
                "Reconciles the load order against this snapshot (ADR-0013): every physical plugin " +
                "copy in the instance — winning and losing, listed and unlisted — each with its " +
                "plugins.txt slot (null when no line names it), its * prefix and whether the Mod " +
                "override order resolves the name to it. Copies new to the load order are opened " +
                "and registered (indexed only if never seen), copies absent from the snapshot are " +
                "unregistered, moved copies are re-registered SQL-only; then one winner sweep. " +
                "Vanilla masters are prepended by the backend and need not be listed. Answers as " +
                "soon as the snapshot is applied; the sweep runs after, reported on " +
                "GET /load-order/status and the load-order-status notification.")
            .Produces<LoadOrderResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500);

        // ADR-0013: polled alongside an in-flight PUT, so it answers 200 in every state
        // including "no load order yet" — unlike the gated routes below, reporting that absence
        // *is* this endpoint's job, not a failure to do it.
        app.MapGet("/load-order/status", GetStatus)
            .WithName("GetLoadOrderStatus")
            .WithTags(Tag)
            .Produces<LoadOrderStatus>();

        app.MapPost("/load-order/filter", SetFilter)
            .WithName("SetFilter")
            .WithTags(Tag)
            .Produces<FilterResponse>()
            .ProducesProblem(400)
            .ProducesProblem(503)
            .ProducesProblem(500);

        app.MapDelete("/load-order/filter", ClearFilter)
            .WithName("ClearFilter")
            .WithTags(Tag)
            .Produces(204)
            .ProducesProblem(503)
            .ProducesProblem(500);

        app.MapGet("/load-order/filter", GetFilter)
            .WithName("GetFilter")
            .WithTags(Tag)
            .Produces<FilterResponse>()
            .ProducesProblem(503);

        // ADR-0014: the read side's read-your-writes hook. 0 with no index held, the same
        // "absence is a state" answer GetLoadOrderStatus gives.
        app.MapGet("/load-order/sequence", GetSequence)
            .WithName("GetSequence")
            .WithTags(Tag)
            .Produces<long>();

        app.MapGet("/load-order/sequence/await", AwaitSequence)
            .WithName("AwaitSequence")
            .WithTags(Tag)
            .Produces<SequenceAwaitResponse>()
            .ProducesProblem(400);

        // Answered from the game directory alone, with no load order held: Mod Management asks it
        // while reconciling plugins.txt, which is what a PUT is built from.
        app.MapGet("/implicit-masters", GetImplicitMasters)
            .WithName("GetImplicitMasters")
            .WithTags(Tag)
            .WithDescription(
                "The plugin filenames this install loads without a plugins.txt line of their own: " +
                "the release's implicit masters present in the given Data folder, then that " +
                "folder's Creation Club catalog. Load order.")
            .Produces<IReadOnlyList<string>>()
            .ProducesProblem(400);

        // ADR-0014: Refresh's own first step — the PUT /load-order that follows is then an
        // ordinary cold load. Refuses exactly as PUT /load-order does when another window holds
        // the file.
        app.MapPost("/index/rebuild", PostRebuildIndex)
            .WithName("PostRebuildIndex")
            .WithTags(Tag)
            .Produces(204)
            .ProducesProblem(400)
            .ProducesProblem(423)
            .ProducesProblem(500);

        return app;
    }

    // ADR-0009 point 5: another Modbench window holds this instance's index. 423 Locked, distinct
    // from a failed reconcile (500) and a superseded snapshot (409): nothing is wrong, the
    // instance is simply in use.
    private static IResult IndexHeldElsewhere(ILogger logger, IndexHeldElsewhereException ex)
    {
        logger.LogWarning(ex, "Refused load order: the index at {Path} is held by another window", ex.IndexPath);
        return Results.Problem(ex.Message, statusCode: 423);
    }

    private static IResult? ParseGameRelease(string? raw, out GameRelease release)
    {
        return Enum.TryParse(raw, out release)
            ? null
            : Results.Problem($"Unknown game release: '{raw}'. Valid values: {string.Join(", ", Enum.GetNames<GameRelease>())}", statusCode: 400);
    }

    internal static IResult PutLoadOrder(LoadOrderRequest req, PutLoadOrderHandler handler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(LoadOrderEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received PutLoadOrder for {InstanceRoot} ({Count} plugin copies)", req.InstanceRoot, req.Plugins?.Count ?? 0);
        }
        if (!Directory.Exists(req.GameDirectory))
            return Results.Problem($"Game directory not found: {req.GameDirectory}", statusCode: 400);
        // ADR-0009: the MO2 instance root is what the index file is keyed on, so a snapshot
        // that cannot name one has nowhere to keep its rows — a bad request, not a degraded reconcile.
        if (!Directory.Exists(req.InstanceRoot))
            return Results.Problem($"Instance root not found: {req.InstanceRoot}", statusCode: 400);

        if (ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;

        // Every registration fact is Mod Management's to state, never defaulted here: a missing
        // bool silently bound to false would make every copy non-participating.
        if (req.Plugins?.Any(p => string.IsNullOrEmpty(p.Name) || string.IsNullOrEmpty(p.Path) || string.IsNullOrEmpty(p.Origin) || p.Enabled is null || p.Winning is null) != false)
            return Results.Problem("Each plugin entry must have a non-empty Name, Path, and Origin, and must state Enabled and Winning.", statusCode: 400);

        try
        {
            var entries = req.Plugins
                .Select(p => new LoadOrderEntry(p.Name, p.Path, p.Origin, p.Slot, p.Enabled!.Value, p.Winning!.Value))
                .ToList();
            var snapshot = ForcedPlugins.Snapshot(req.GameDirectory, req.InstanceRoot, gameRelease, entries);
            var result = handler.Put(snapshot);
            return result.Applied ? Results.Ok(new LoadOrderResponse(true, result.Version)) : WriteEndpointMapping.Refusal(result);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to apply the load order for {InstanceRoot}", req.InstanceRoot);
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    internal static IResult PostRebuildIndex(RebuildIndexRequest req, IndexProjector index, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(LoadOrderEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received PostRebuildIndex for {InstanceRoot}", req.InstanceRoot);
        }
        if (!Directory.Exists(req.InstanceRoot))
            return Results.Problem($"Instance root not found: {req.InstanceRoot}", statusCode: 400);
        if (ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;

        try
        {
            index.RebuildStore(gameRelease, req.InstanceRoot);
            return Results.NoContent();
        }
        catch (IndexHeldElsewhereException ex)
        {
            return IndexHeldElsewhere(logger, ex);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to rebuild the index for {InstanceRoot}", req.InstanceRoot);
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    // Deliberately not logged at Information like its neighbours: the Plugins tree polls this every
    // few hundred milliseconds for the duration of a reconcile, and one reception line per poll
    // would bury the per-plugin indexing lines it sits between.
    private static IResult GetStatus(IQueryIndex index, ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(LoadOrderEndpoints)).LogTrace("Received GetLoadOrderStatus");
        return Results.Ok(index.Status);
    }

    private static IResult GetSequence(IRefreshIndex index) => Results.Ok(index.Sequence);

    // An absent directory is a bad request, not an empty answer: "no implicit masters" and "that
    // folder isn't there" want opposite responses from the caller.
    internal static IResult GetImplicitMasters(string gameDirectory, string gameRelease)
    {
        if (!Directory.Exists(gameDirectory))
            return Results.Problem($"Game directory not found: {gameDirectory}", statusCode: 400);
        if (ParseGameRelease(gameRelease, out var release) is { } releaseErr) return releaseErr;
        return Results.Ok(ForcedPlugins.Names(gameDirectory, release));
    }

    private static async Task<IResult> AwaitSequence(IndexProjector index, long atLeast, int timeoutMs = 5000)
    {
        if (timeoutMs <= 0)
            return Results.Problem("timeoutMs must be positive.", statusCode: 400);

        var reached = await index.AwaitSequenceAsync(atLeast, TimeSpan.FromMilliseconds(timeoutMs));
        return Results.Ok(new SequenceAwaitResponse(reached, index.Sequence));
    }

    private static IResult SetFilter(FilterRequest req, IndexProjector index, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(LoadOrderEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received SetFilter with {Sql}", req.Sql);
        }
        if (req.Sql is null)
            return Results.Problem("SQL is required.", statusCode: 400);
        try
        {
            index.SetFilter(req.Sql);
            return Results.Ok(new FilterResponse(req.Sql));
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No load order when setting filter");
            return WriteEndpointMapping.NoLoadOrder(ex);
        }
        catch (ArgumentException ex)
        {
            logger.LogError(ex, "Invalid filter SQL");
            return Results.Problem(ex.Message, statusCode: 400);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to apply filter");
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    private static IResult ClearFilter(IndexProjector index, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(LoadOrderEndpoints));
        logger.LogInformation("Received ClearFilter");
        try
        {
            index.ClearFilter();
            return Results.NoContent();
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No load order when clearing filter");
            return WriteEndpointMapping.NoLoadOrder(ex);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to clear filter");
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    private static IResult GetFilter(IQueryIndex index, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(LoadOrderEndpoints));
        logger.LogInformation("Received GetFilter");
        try
        {
            index.RequireReads();
            return Results.Ok(new FilterResponse(index.FilterSql));
        }
        catch (NoLoadOrderException ex)
        {
            logger.LogError(ex, "No load order when getting filter");
            return WriteEndpointMapping.NoLoadOrder(ex);
        }
    }
}
