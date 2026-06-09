using MEditService.Core.Queries;
using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Api.Endpoints;

public static class SessionEndpoints
{
    public static IEndpointRouteBuilder MapSessionEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/session/load", (SessionLoadRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger(nameof(SessionEndpoints));
            if (!Directory.Exists(req.DataFolderPath))
                return Results.Problem($"Data folder not found: {req.DataFolderPath}", statusCode: 400);
            if (!File.Exists(req.PluginsTxtPath))
                return Results.Problem($"Plugins.txt not found: {req.PluginsTxtPath}", statusCode: 400);

            if (!Enum.TryParse<GameRelease>(req.GameRelease, out var gameRelease))
                return Results.Problem($"Unknown game release: '{req.GameRelease}'. Valid values: {string.Join(", ", Enum.GetNames<GameRelease>())}", statusCode: 400);

            try
            {
                sessionManager.Load(req.DataFolderPath, req.PluginsTxtPath, gameRelease);
                return Results.Ok(new { status = "loaded" });
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to load session for {DataFolder}", req.DataFolderPath);
                return Results.Problem(ex.Message, statusCode: 500);
            }
        })
        .WithName("LoadSession")
        .WithTags("Session");

        app.MapPost("/session/filter", (SessionFilterRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory) =>
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
        })
        .WithName("SetFilter")
        .WithTags("Session")
        .Produces<SessionFilterResponse>()
        .ProducesProblem(400)
        .ProducesProblem(503)
        .ProducesProblem(500);

        app.MapDelete("/session/filter", (ISessionManager sessionManager, ILoggerFactory loggerFactory) =>
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
        })
        .WithName("ClearFilter")
        .WithTags("Session")
        .Produces(204)
        .ProducesProblem(503)
        .ProducesProblem(500);

        app.MapGet("/session/filter", (ISessionManager sessionManager) =>
        {
            if (sessionManager.Session is null)
                return Results.Problem("No session loaded.", statusCode: 503);
            return Results.Ok(new SessionFilterResponse(sessionManager.Session.FilterSql));
        })
        .WithName("GetFilter")
        .WithTags("Session")
        .Produces<SessionFilterResponse>()
        .ProducesProblem(503);

        return app;
    }
}

public record SessionLoadRequest(string DataFolderPath, string PluginsTxtPath, string GameRelease = "Fallout4");
