using MEditService.Bridge;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Api.Endpoints;

public static class LoadOrderEndpoints
{
    private const string Tag = "LoadOrder";

    public static IEndpointRouteBuilder MapLoadOrderEndpoints(this IEndpointRouteBuilder app)
    {
        // ADR-0044: the one way the load order reaches Editing — an idempotent snapshot of every
        // physical plugin copy in the instance, reconciled against what is held. PUT, because it
        // is state, not a command: sending the same body twice changes nothing.
        app.MapPut("/load-order", PutLoadOrder)
            .WithName("PutLoadOrder")
            .WithTags(Tag)
            .WithDescription(
                "Reconciles the load order against this snapshot (ADR-0044): every physical plugin " +
                "copy in the instance — winning and losing, listed and unlisted — each with its " +
                "plugins.txt slot (null when no line names it), its * prefix and whether the Mod " +
                "override order resolves the name to it. Copies new to the load order are opened " +
                "and registered (indexed only if never seen), copies absent from the snapshot are " +
                "unregistered, moved copies are re-registered SQL-only; then one winner sweep. " +
                "Vanilla masters are prepended by the backend and need not be listed. Blocks until " +
                "the sweep has run; poll GET /load-order/status alongside for progress.")
            .Produces<LoadOrderResponse>()
            .ProducesProblem(423)
            .ProducesProblem(400)
            .ProducesProblem(409)
            .ProducesProblem(500);

        // #274 / ADR-0035: polled alongside an in-flight PUT, so it answers 200 in every state
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

        return app;
    }

    // #274: this reconcile was cancelled because something replaced it — another snapshot, or a
    // close. 409 rather than 500: nothing went wrong, and the caller must be able to tell "your
    // snapshot was superseded" (ignore it; the newer one owns the load order) from "the reconcile
    // failed" (surface it). A warning, not an error, for the same reason.
    private static IResult SupersededReconcile(ILogger logger, OperationCanceledException ex)
    {
        logger.LogWarning(ex, "Load order reconcile was cancelled before it completed");
        return Results.Problem("The load order snapshot was superseded by a newer one or by closing the load order.", statusCode: 409);
    }

    // #445: a client asking for a release this build has no Mutagen assembly for is a bad request,
    // not a server fault — 400 with the exception's own actionable message (names the release and
    // the missing assembly), matching ParseGameRelease's own 400 for a bad enum string just above.
    private static IResult UnsupportedGameRelease(ILogger logger, UnsupportedGameReleaseException ex)
    {
        logger.LogWarning(ex, "Rejected load order for unsupported game release {Release}", ex.Release);
        return Results.Problem(ex.Message, statusCode: 400);
    }

    // #588 / ADR-0001 point 6: another Modbench window holds this instance's index. 423 Locked, so
    // the client can tell it from a failed reconcile (500) and from its own superseded snapshot
    // (409): nothing is wrong with the snapshot or the index, the instance is simply in use. A
    // warning, not an error — the user opened two windows on one instance, and the message says so.
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

    // internal (not private), matching Compile/ExternalChangeStatus's own visibility in this
    // codebase: the door LoadOrderEndpointsTests exercises directly, real fixture and all — same
    // "thin, mapping-only" precedent ExternalChangeEndpointsTests already established.
    internal static IResult PutLoadOrder(LoadOrderRequest req, ILoadOrderMirror mirror, ExternalChangeWatcher externalChangeWatcher, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(LoadOrderEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received PutLoadOrder for {InstanceRoot} ({Count} plugin copies)", req.InstanceRoot, req.Plugins?.Count ?? 0);
        }
        if (!Directory.Exists(req.GameDirectory))
            return Results.Problem($"Game directory not found: {req.GameDirectory}", statusCode: 400);
        // #592 / ADR-0001: the MO2 instance root is what the index file is keyed on, so a snapshot
        // that cannot name one has nowhere to keep its rows — a bad request, not a degraded reconcile.
        if (!Directory.Exists(req.InstanceRoot))
            return Results.Problem($"Instance root not found: {req.InstanceRoot}", statusCode: 400);

        if (ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;

        // Every one of the three registration facts is Mod Management's to state, never defaulted
        // here (#275 for Origin, #270 for the `*` prefix): a bool that silently bound a missing
        // property to false would make every copy non-participating, so nothing would win any
        // FormKey and the conflict picture would be empty but well-formed.
        if (req.Plugins?.Any(p => string.IsNullOrEmpty(p.Name) || string.IsNullOrEmpty(p.Path) || string.IsNullOrEmpty(p.Origin) || p.Enabled is null || p.Winning is null) != false)
            return Results.Problem("Each plugin entry must have a non-empty Name, Path, and Origin, and must state Enabled and Winning.", statusCode: 400);

        // A copy whose file is gone by the time the snapshot arrives (MO2, or the user, deleting it
        // between the walk and the PUT — root CLAUDE.md's never-assume-exclusive-ownership rule) is
        // not a bad request but a row in an error state (ADR-0044): LoadOrder.Open records it in
        // Failures and the rest of the snapshot reconciles.
        try
        {
            var entries = req.Plugins
                .Select(p => new LoadOrderEntry(p.Name, p.Path, p.Origin, p.Slot, p.Enabled!.Value, p.Winning!.Value))
                .ToList();
            mirror.Reconcile(req.GameDirectory, entries, gameRelease, req.InstanceRoot);
            // #417 AC4 / #381: the hash check, plus (re-)registering the live watch for every
            // plugin the load order now holds — one pass, right after the completion signal this
            // endpoint has always been (the PUT returns only once the sweep has run). Its return is
            // #381's crash-repair offers, riding the response the same way Failures already does.
            // Closes #590: a copy registered by any reconcile gets its mirror watch here.
            var crashRepairOffers = ExternalChangeLoadOrderHook.RunAfterReconcile(
                mirror.LoadOrder, mirror.Index, externalChangeWatcher, logger);
            return Results.Ok(new LoadOrderResponse("reconciled", mirror.LoadOrder?.LoadFailures ?? [], crashRepairOffers));
        }
        catch (OperationCanceledException ex)
        {
            return SupersededReconcile(logger, ex);
        }
        catch (UnsupportedGameReleaseException ex)
        {
            return UnsupportedGameRelease(logger, ex);
        }
        catch (IndexHeldElsewhereException ex)
        {
            return IndexHeldElsewhere(logger, ex);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to reconcile the load order for {InstanceRoot}", req.InstanceRoot);
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    // Deliberately not logged at Information like its neighbours: the Plugins tree polls this every
    // few hundred milliseconds for the duration of a reconcile, and one reception line per poll
    // would bury the per-plugin indexing lines it sits between.
    private static IResult GetStatus(ILoadOrderMirror mirror, ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(LoadOrderEndpoints)).LogTrace("Received GetLoadOrderStatus");
        return Results.Ok(mirror.Status);
    }

    private static IResult SetFilter(FilterRequest req, ILoadOrderMirror mirror, ILoggerFactory loggerFactory)
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
            mirror.SetFilter(req.Sql);
            return Results.Ok(new FilterResponse(req.Sql));
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No load order when setting filter");
            return Results.Problem(ex.Message, statusCode: 503);
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

    private static IResult ClearFilter(ILoadOrderMirror mirror, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(LoadOrderEndpoints));
        logger.LogInformation("Received ClearFilter");
        try
        {
            mirror.ClearFilter();
            return Results.NoContent();
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No load order when clearing filter");
            return Results.Problem(ex.Message, statusCode: 503);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to clear filter");
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    private static IResult GetFilter(ILoadOrderMirror mirror, ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(LoadOrderEndpoints)).LogInformation("Received GetFilter");
        return mirror.LoadOrder is null
            ? Results.Problem("No load order has been received.", statusCode: 503)
            : Results.Ok(new FilterResponse(mirror.LoadOrder.FilterSql));
    }
}
