using MEditService.Bridge;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Api.Endpoints;

public static class SessionEndpoints
{
    private const string Tag = "Session";

    public static IEndpointRouteBuilder MapSessionEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/session/load", LoadSession)
            .WithName("LoadSession")
            .WithTags(Tag)
            .Produces<SessionLoadResponse>()
            .ProducesProblem(400)
            .ProducesProblem(409)
            .ProducesProblem(500);

        app.MapPost("/session/load-explicit", LoadExplicitSession)
            .WithName("LoadExplicitSession")
            .WithTags(Tag)
            .Produces<SessionLoadResponse>()
            .ProducesProblem(400)
            .ProducesProblem(409)
            .ProducesProblem(500);

        // #274 / ADR-0035: polled alongside an in-flight load, so it answers 200 in every state
        // including "no session" — unlike the session-gated routes below, reporting the absence of a
        // session *is* this endpoint's job, not a failure to do it.
        app.MapGet("/session/status", GetStatus)
            .WithName("GetSessionStatus")
            .WithTags(Tag)
            .Produces<SessionStatus>();

        app.MapPost("/session/filter", SetFilter)
            .WithName("SetFilter")
            .WithTags(Tag)
            .Produces<SessionFilterResponse>()
            .ProducesProblem(400)
            .ProducesProblem(503)
            .ProducesProblem(500);

        app.MapDelete("/session/filter", ClearFilter)
            .WithName("ClearFilter")
            .WithTags(Tag)
            .Produces(204)
            .ProducesProblem(503)
            .ProducesProblem(500);

        app.MapGet("/session/filter", GetFilter)
            .WithName("GetFilter")
            .WithTags(Tag)
            .Produces<SessionFilterResponse>()
            .ProducesProblem(503);

        return app;
    }

    // #274: this load was cancelled because something replaced it — another load, or a session
    // teardown. 409 rather than 500: nothing went wrong, and the caller must be able to tell "your
    // load was superseded" (ignore it; the newer one owns the session) from "the load failed"
    // (surface it). A warning, not an error, for the same reason.
    private static IResult SupersededLoad(ILogger logger, OperationCanceledException ex)
    {
        logger.LogWarning(ex, "Session load was cancelled before it completed");
        return Results.Problem("The session load was superseded by another load or by unloading the session.", statusCode: 409);
    }

    // #445: a client asking for a release this build has no Mutagen assembly for is a bad request,
    // not a server fault — 400 with the exception's own actionable message (names the release and
    // the missing assembly), matching ParseGameRelease's own 400 for a bad enum string just above.
    private static IResult UnsupportedGameRelease(ILogger logger, UnsupportedGameReleaseException ex)
    {
        logger.LogWarning(ex, "Rejected session load for unsupported game release {Release}", ex.Release);
        return Results.Problem(ex.Message, statusCode: 400);
    }

    private static IResult? ParseGameRelease(string? raw, out GameRelease release)
    {
        return Enum.TryParse(raw, out release)
            ? null
            : Results.Problem($"Unknown game release: '{raw}'. Valid values: {string.Join(", ", Enum.GetNames<GameRelease>())}", statusCode: 400);
    }

    internal static IResult LoadSession(SessionLoadRequest req, ISessionManager sessionManager, ExternalChangeWatcher externalChangeWatcher, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(SessionEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received LoadSession for {DataFolder}", req.DataFolderPath);
        }
        if (!Directory.Exists(req.DataFolderPath))
            return Results.Problem($"Data folder not found: {req.DataFolderPath}", statusCode: 400);
        if (!File.Exists(req.PluginsTxtPath))
            return Results.Problem($"Plugins.txt not found: {req.PluginsTxtPath}", statusCode: 400);

        if (ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;

        try
        {
            sessionManager.Load(req.DataFolderPath, req.PluginsTxtPath, gameRelease);
            // #417 AC4 / #381: the load-time hash check, plus (re-)registering the live watch for
            // every tracked plugin this load now holds — one pass, right after the completion
            // signal this endpoint has always been (POST /session/load returns only once loading
            // finishes). Its return is #381's crash-repair offers, riding the response the same way
            // LoadFailures already does.
            var crashRepairOffers = ExternalChangeSessionHook.RunAfterLoad(
                sessionManager.Session, sessionManager.Index, externalChangeWatcher, logger);
            return Results.Ok(new SessionLoadResponse("loaded", sessionManager.Session?.LoadFailures ?? [], crashRepairOffers));
        }
        catch (OperationCanceledException ex)
        {
            return SupersededLoad(logger, ex);
        }
        catch (UnsupportedGameReleaseException ex)
        {
            return UnsupportedGameRelease(logger, ex);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to load session for {DataFolder}", req.DataFolderPath);
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    // internal (not private), matching LoadSession/Compile/ExternalChangeStatus's own visibility in
    // this codebase: the door SessionEndpointsTests exercises directly, real fixture and all — same
    // "thin, mapping-only" precedent ExternalChangeEndpointsTests already established.
    internal static IResult LoadExplicitSession(SessionLoadExplicitRequest req, ISessionManager sessionManager, ExternalChangeWatcher externalChangeWatcher, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(SessionEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received LoadExplicitSession for {GameDirectory}", req.GameDirectory);
        }
        if (!Directory.Exists(req.GameDirectory))
            return Results.Problem($"Game directory not found: {req.GameDirectory}", statusCode: 400);

        if (ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;

        if (req.Plugins?.Any(p => string.IsNullOrEmpty(p.Name) || string.IsNullOrEmpty(p.Path) || string.IsNullOrEmpty(p.Origin) || p.Participates is null) != false)
            return Results.Problem("Each plugin entry must have a non-empty Name, Path, and Origin, and must state Participates.", statusCode: 400);

        var missing = req.Plugins.Where(p => !File.Exists(p.Path)).Select(p => p.Path).ToList();
        if (missing.Count > 0)
            return Results.Problem($"Plugin file(s) not found: {string.Join(", ", missing)}", statusCode: 400);

        try
        {
            // #269 / ADR-0036: Origin is Mod Management's to resolve — required, not defaulted
            // (#275). #270 / ADR-0035: so is Participates, the plugins.txt `*` prefix; the guard
            // above has already rejected a null, so the caller stated it.
            var explicitPlugins = req.Plugins
                .Select(p => new ExplicitPluginInput(p.Name, p.Path, p.Origin, p.Participates!.Value))
                .ToList();
            sessionManager.LoadExplicit(req.GameDirectory, explicitPlugins, gameRelease);
            var crashRepairOffers = ExternalChangeSessionHook.RunAfterLoad(
                sessionManager.Session, sessionManager.Index, externalChangeWatcher, logger);
            return Results.Ok(new SessionLoadResponse("loaded", sessionManager.Session?.LoadFailures ?? [], crashRepairOffers));
        }
        catch (OperationCanceledException ex)
        {
            return SupersededLoad(logger, ex);
        }
        catch (UnsupportedGameReleaseException ex)
        {
            return UnsupportedGameRelease(logger, ex);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to load explicit session from {GameDirectory}", req.GameDirectory);
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    // Deliberately not logged at Information like its neighbours: the Plugins tree polls this every
    // few hundred milliseconds for the duration of a load, and one reception line per poll would
    // bury the per-plugin indexing lines it sits between.
    private static IResult GetStatus(ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(SessionEndpoints)).LogTrace("Received GetSessionStatus");
        return Results.Ok(sessionManager.Status);
    }

    private static IResult SetFilter(SessionFilterRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(SessionEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received SetFilter with {Sql}", req.Sql);
        }
        if (req.Sql is null)
            return Results.Problem("SQL is required.", statusCode: 400);
        try
        {
            sessionManager.SetFilter(req.Sql);
            return Results.Ok(new SessionFilterResponse(req.Sql));
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No session when setting filter");
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

    private static IResult ClearFilter(ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(SessionEndpoints));
        logger.LogInformation("Received ClearFilter");
        try
        {
            sessionManager.ClearFilter();
            return Results.NoContent();
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No session when clearing filter");
            return Results.Problem(ex.Message, statusCode: 503);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to clear filter");
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    private static IResult GetFilter(ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(SessionEndpoints)).LogInformation("Received GetFilter");
        return sessionManager.Session is null
            ? Results.Problem("No session loaded.", statusCode: 503)
            : Results.Ok(new SessionFilterResponse(sessionManager.Session.FilterSql));
    }
}

public record SessionLoadRequest(string DataFolderPath, string PluginsTxtPath, string GameRelease = "Fallout4");
