using MEditService.Core.Session;
using Mutagen.Bethesda;

namespace MEditService.Api.Endpoints;

public static class SessionEndpoints
{
    public static IEndpointRouteBuilder MapSessionEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/session/load", (SessionLoadRequest req, ISessionManager sessionManager) =>
        {
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
                return Results.Problem(ex.ToString(), statusCode: 500);
            }
        })
        .WithName("LoadSession")
        .WithTags("Session");

        return app;
    }
}

public record SessionLoadRequest(string DataFolderPath, string PluginsTxtPath, string GameRelease = "Fallout4");
