using MEditService.Core.Queries;
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
            .ProducesProblem(500);

        app.MapPost("/session/load-explicit", LoadExplicitSession)
            .WithName("LoadExplicitSession")
            .WithTags(Tag)
            .Produces<SessionLoadResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500);

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

    private static IResult? ParseGameRelease(string? raw, out GameRelease release)
    {
        if (Enum.TryParse(raw, out release)) return null;
        return Results.Problem($"Unknown game release: '{raw}'. Valid values: {string.Join(", ", Enum.GetNames<GameRelease>())}", statusCode: 400);
    }

    private static IResult LoadSession(SessionLoadRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(SessionEndpoints));
        if (!Directory.Exists(req.DataFolderPath))
            return Results.Problem($"Data folder not found: {req.DataFolderPath}", statusCode: 400);
        if (!File.Exists(req.PluginsTxtPath))
            return Results.Problem($"Plugins.txt not found: {req.PluginsTxtPath}", statusCode: 400);

        if (ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;

        try
        {
            sessionManager.Load(req.DataFolderPath, req.PluginsTxtPath, gameRelease);
            return Results.Ok(new SessionLoadResponse("loaded", sessionManager.Session?.LoadFailures ?? []));
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to load session for {DataFolder}", req.DataFolderPath);
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    private static IResult LoadExplicitSession(SessionLoadExplicitRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(SessionEndpoints));
        if (!Directory.Exists(req.GameDirectory))
            return Results.Problem($"Game directory not found: {req.GameDirectory}", statusCode: 400);

        if (ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;

        if (req.Plugins is null || req.Plugins.Any(p => string.IsNullOrEmpty(p.Name) || string.IsNullOrEmpty(p.Path)))
            return Results.Problem("Each plugin entry must have a non-empty Name and Path.", statusCode: 400);

        var missing = req.Plugins.Where(p => !File.Exists(p.Path)).Select(p => p.Path).ToList();
        if (missing.Count > 0)
            return Results.Problem($"Plugin file(s) not found: {string.Join(", ", missing)}", statusCode: 400);

        try
        {
            var explicitPlugins = req.Plugins.Select(p => (p.Name, p.Path)).ToList();
            sessionManager.LoadExplicit(req.GameDirectory, explicitPlugins, gameRelease);
            return Results.Ok(new SessionLoadResponse("loaded", sessionManager.Session?.LoadFailures ?? []));
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to load explicit session from {GameDirectory}", req.GameDirectory);
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }

    private static IResult SetFilter(SessionFilterRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(SessionEndpoints));
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

    private static IResult GetFilter(ISessionManager sessionManager)
    {
        if (sessionManager.Session is null)
            return Results.Problem("No session loaded.", statusCode: 503);
        return Results.Ok(new SessionFilterResponse(sessionManager.Session.FilterSql));
    }
}

public record SessionLoadRequest(string DataFolderPath, string PluginsTxtPath, string GameRelease = "Fallout4");
