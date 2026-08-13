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

        MapCatalog(app, "/record-types", "GetRecordTypes", svc => svc.GetRecordTypes());

        // The condition function picker's catalog (#152) — filtered to what the loaded session's
        // game actually resolves (ConditionCodecRegistry), not a hardcoded list.
        MapCatalog(app, "/condition-functions", "GetConditionFunctions", svc => svc.GetConditionFunctions());

        // The Run On target dropdown's catalog (#167) — filtered to what the loaded session's
        // game actually resolves (ConditionCodecRegistry), not a hardcoded frontend array.
        MapCatalog(app, "/condition-run-on-targets", "GetConditionRunOnTargets", svc => svc.GetConditionRunOnTargets());

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

        app.MapPost("/plugins/load", LoadUnlistedPlugin)
            .WithName("LoadUnlistedPlugin")
            .WithTags("Plugins")
            .Produces<PluginResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(503);

        return app;
    }

    // Shared shape for the /record-types, /condition-functions and /condition-run-on-targets
    // catalog endpoints (#244): log receipt, run the read against the loaded session, and map the
    // "no session loaded" failure (RequireSession()'s InvalidOperationException) to the same 503
    // CreatePlugin's own catch below uses.
    private static void MapCatalog(
        IEndpointRouteBuilder app, string route, string name, Func<IRecordQueryService, IReadOnlyList<string>> getCatalog)
    {
        app.MapGet(route, (IRecordQueryService svc, ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
            logger.LogInformation("Received {Name}", name);
            try
            {
                return Results.Ok(getCatalog(svc));
            }
            catch (InvalidOperationException ex)
            {
                logger.LogError(ex, "No session for {Name}", name);
                return Results.Problem(ex.Message, statusCode: 503);
            }
        })
            .WithName(name)
            .WithTags("Records")
            .Produces<IReadOnlyList<string>>()
            .ProducesProblem(503);
    }

    // #34 / ADR-0035: loads a plugin file the effective load order does not name. The caller
    // (Mod Management, which owns mods/ and the file-conflict merge) supplies the physical path
    // and the origin it resolved the file from; the session decides everything else, since
    // read-only-ness and non-participation are properties of not being in the load order, not
    // choices a caller makes.
    internal static IResult LoadUnlistedPlugin(LoadPluginRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        logger.LogInformation("Received LoadUnlistedPlugin for {Path} from {Origin}", req.Path, req.Origin);
        if (string.IsNullOrWhiteSpace(req.Path) || string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Plugin path and origin are required.", statusCode: 400);

        try
        {
            return Results.Ok(sessionManager.LoadUnlistedPlugin(req.Path, req.Origin));
        }
        catch (FileNotFoundException ex)
        {
            logger.LogError(ex, "Unlisted plugin file not found: {Path}", req.Path);
            return Results.Problem(ex.Message, statusCode: 404);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No session when loading unlisted plugin {Path}", req.Path);
            return Results.Problem(ex.Message, statusCode: 503);
        }
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

public record LoadPluginRequest(string Path, string Origin);
