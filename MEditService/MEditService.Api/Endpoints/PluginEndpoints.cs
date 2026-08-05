using MEditService.Core.Queries;
using MEditService.Core.Session;

namespace MEditService.Api.Endpoints;

public static class PluginEndpoints
{
    public static IEndpointRouteBuilder MapPluginEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/plugins", (IRecordQueryService svc, ILoggerFactory loggerFactory) =>
        {
            loggerFactory.CreateLogger(nameof(PluginEndpoints)).LogInformation("Received GetPlugins");
            return Results.Ok(svc.GetPlugins());
        })
            .WithName("GetPlugins")
            .WithTags("Plugins")
            .Produces<IReadOnlyList<PluginResponse>>();

        app.MapGet("/record-types", (IRecordQueryService svc, ILoggerFactory loggerFactory) =>
        {
            loggerFactory.CreateLogger(nameof(PluginEndpoints)).LogInformation("Received GetRecordTypes");
            return Results.Ok(svc.GetRecordTypes());
        })
            .WithName("GetRecordTypes")
            .WithTags("Records")
            .Produces<IReadOnlyList<string>>();

        // The condition function picker's catalog (#152) — filtered to what the loaded session's
        // game actually resolves (ConditionCodecRegistry), not a hardcoded list.
        app.MapGet("/condition-functions", (IRecordQueryService svc, ILoggerFactory loggerFactory) =>
        {
            loggerFactory.CreateLogger(nameof(PluginEndpoints)).LogInformation("Received GetConditionFunctions");
            return Results.Ok(svc.GetConditionFunctions());
        })
            .WithName("GetConditionFunctions")
            .WithTags("Records")
            .Produces<IReadOnlyList<string>>();

        // The Run On target dropdown's catalog (#167) — filtered to what the loaded session's
        // game actually resolves (ConditionCodecRegistry), not a hardcoded frontend array.
        app.MapGet("/condition-run-on-targets", (IRecordQueryService svc, ILoggerFactory loggerFactory) =>
        {
            loggerFactory.CreateLogger(nameof(PluginEndpoints)).LogInformation("Received GetConditionRunOnTargets");
            return Results.Ok(svc.GetConditionRunOnTargets());
        })
            .WithName("GetConditionRunOnTargets")
            .WithTags("Records")
            .Produces<IReadOnlyList<string>>()
            // RequireSession() throws InvalidOperationException when no session is loaded — same
            // "no session loaded" case CreatePlugin's own catch maps to 503 below. This endpoint
            // doesn't yet catch it itself (#244 tracks fixing that uniformly across all three
            // catalog endpoints in this file); the annotation documents the real failure mode so
            // the generated client's type isn't a lie about what can come back.
            .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/record-types", (string plugin, IRecordQueryService svc, ILoggerFactory loggerFactory) =>
        {
            loggerFactory.CreateLogger(nameof(PluginEndpoints)).LogInformation("Received GetPluginRecordTypes for {Plugin}", plugin);
            var decoded = Uri.UnescapeDataString(plugin);
            return Results.Ok(svc.GetPluginRecordTypes(decoded));
        })
            .WithName("GetPluginRecordTypes")
            .WithTags("Plugins")
            .Produces<IReadOnlyList<PluginRecordTypeCount>>();

        app.MapPost("/plugins/create", CreatePlugin)
            .WithName("CreatePlugin")
            .WithTags("Plugins")
            .Produces<PluginResponse>()
            .ProducesProblem(400)
            .ProducesProblem(409);

        return app;
    }

    internal static IResult CreatePlugin(CreatePluginRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        logger.LogInformation("Received CreatePlugin for {Name}", req.Name);
        if (string.IsNullOrWhiteSpace(req.Name))
            return Results.Problem("Plugin name is required.", statusCode: 400);

        try
        {
            var plugin = sessionManager.CreatePlugin(req.Name);
            return Results.Ok(plugin);
        }
        catch (ArgumentException ex)
        {
            logger.LogError(ex, "Invalid argument creating plugin {Name}", req.Name);
            return Results.Problem(ex.Message, statusCode: 400);
        }
        catch (System.IO.IOException ex)
        {
            logger.LogError(ex, "IO error creating plugin {Name}", req.Name);
            return Results.Problem(ex.Message, statusCode: 409);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No session when creating plugin {Name}", req.Name);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }
}

public record CreatePluginRequest(string Name);
