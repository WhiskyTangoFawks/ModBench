using MEditService.Core.Ledger;
using MEditService.Core.Queries;
using MEditService.Core.Session;

namespace MEditService.Api.Endpoints;

public static class PluginEndpoints
{
    private const string Tag = "Plugins";

    public static IEndpointRouteBuilder MapPluginEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/plugins", (IRecordQueryService svc, ILoggerFactory loggerFactory) =>
        {
            loggerFactory.CreateLogger(nameof(PluginEndpoints)).LogInformation("Received GetPlugins");
            return Results.Ok(svc.GetPlugins());
        })
            .WithName("GetPlugins")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginResponse>>();

        MapCatalog(app, "/record-types", "GetRecordTypes", svc => svc.GetRecordTypes());

        // The condition function picker's catalog (#152) — filtered to what the loaded session's
        // game actually resolves (ConditionCodecRegistry), not a hardcoded list.
        MapCatalog(app, "/condition-functions", "GetConditionFunctions", svc => svc.GetConditionFunctions());

        // The Run On target dropdown's catalog (#167) — filtered to what the loaded session's
        // game actually resolves (ConditionCodecRegistry), not a hardcoded frontend array.
        MapCatalog(app, "/condition-run-on-targets", "GetConditionRunOnTargets", svc => svc.GetConditionRunOnTargets());

        app.MapGet("/plugins/{plugin}/record-types", (string plugin, string? origin, IRecordQueryService svc, ILoggerFactory loggerFactory) =>
        {
            loggerFactory.CreateLogger(nameof(PluginEndpoints)).LogInformation("Received GetPluginRecordTypes for {Plugin} ({Origin})", plugin, origin);
            var decoded = Uri.UnescapeDataString(plugin);
            return Results.Ok(svc.GetPluginRecordTypes(decoded, origin));
        })
            .WithName("GetPluginRecordTypes")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PluginRecordTypeCount>>();

        app.MapPost("/plugins/create", CreatePlugin)
            .WithName("CreatePlugin")
            .WithTags(Tag)
            .Produces<PluginResponse>()
            .ProducesProblem(400)
            .ProducesProblem(409);

        app.MapPost("/plugins/load", LoadUnlistedPlugin)
            .WithName("LoadUnlistedPlugin")
            .WithTags(Tag)
            .Produces<PluginResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(503);

        app.MapPost("/plugins/unload", UnloadUnlistedPlugin)
            .WithName("UnloadUnlistedPlugin")
            .WithTags(Tag)
            .Produces(204)
            .ProducesProblem(400)
            .ProducesProblem(409)
            .ProducesProblem(503);

        app.MapPost("/plugins/reread", RereadPlugin)
            .WithName("RereadPlugin")
            .WithTags(Tag)
            .Produces<PluginResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(503);

        app.MapPost("/plugins/track", Track)
            .WithName("Track")
            .WithTags(Tag)
            .Produces<TrackResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(500)
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

    internal static IResult UnloadUnlistedPlugin(UnloadPluginRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        logger.LogInformation("Received UnloadUnlistedPlugin for {Plugin} from {Origin}", req.Plugin, req.Origin);
        if (string.IsNullOrWhiteSpace(req.Plugin) || string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Plugin name and origin are required.", statusCode: 400);

        try
        {
            sessionManager.UnloadUnlistedPlugin(req.Plugin, req.Origin);
            return Results.NoContent();
        }
        catch (KeyNotFoundException ex)
        {
            // 409, not 404: the common way to reach this is naming a plugin that *is* loaded but is
            // a load-order member, which is a conflict with what that plugin is, not a missing
            // resource. Only the toggle's own copies are unloadable.
            logger.LogWarning(ex, "Refused to unload {Plugin} from {Origin}", req.Plugin, req.Origin);
            return Results.Problem(ex.Message, statusCode: 409);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No session when unloading {Plugin}", req.Plugin);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }

    // #279 / ADR-0035 § Live mutation: re-reads one plugin from the copy a mod-level change has
    // made its name resolve to. Same division of labour as LoadUnlistedPlugin above — Mod
    // Management owns "which file does this name resolve to" and states the answer, because the
    // session cannot map a filename to a mod folder and must never learn how.
    internal static IResult RereadPlugin(RereadPluginRequest req, ISessionManager sessionManager, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        logger.LogInformation("Received RereadPlugin for {Plugin} from {Origin}", req.Plugin, req.Origin);
        if (string.IsNullOrWhiteSpace(req.Plugin) || string.IsNullOrWhiteSpace(req.Path) || string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Plugin name, path and origin are required.", statusCode: 400);

        try
        {
            return Results.Ok(sessionManager.RereadPlugin(req.Plugin, req.Path, req.Origin));
        }
        catch (SessionBusyException ex)
        {
            // 409, consistent with the session-load contract's own superseded-load answer: nothing
            // went wrong and nothing was touched — the same request is answerable once the load
            // lands. Caught before InvalidOperationException deliberately; see SessionBusyException
            // for why it is not a subclass of one.
            logger.LogWarning(ex, "Refused to re-read {Plugin} while a load is in flight", req.Plugin);
            return Results.Problem(ex.Message, statusCode: 409);
        }
        catch (FileNotFoundException ex)
        {
            logger.LogWarning(ex, "Re-read target not found for {Plugin}: {Path}", req.Plugin, req.Path);
            return Results.Problem(ex.Message, statusCode: 404);
        }
        catch (KeyNotFoundException ex)
        {
            // 404, unlike /plugins/unload's 409: the only way here is naming a plugin the load
            // order does not have, which is a missing resource rather than a conflict with what
            // the named plugin is.
            logger.LogWarning(ex, "No load-order plugin {Plugin} to re-read", req.Plugin);
            return Results.Problem(ex.Message, statusCode: 404);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No session when re-reading {Plugin}", req.Plugin);
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

    // #414/ADR-0041: the Track gesture. Origin names the mod folder (every loaded plugin sharing
    // it gets tracked together — a mod can hold more than one plugin); the session resolves which
    // physical folder that is, same division of labour as RereadPlugin/LoadUnlistedPlugin above.
    internal static async Task<IResult> Track(TrackRequest req, ISessionManager sessionManager, TrackService trackService, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(PluginEndpoints));
        logger.LogInformation("Received Track for {Origin} ({Preset})", req.Origin, req.Preset);
        if (string.IsNullOrWhiteSpace(req.Origin))
            return Results.Problem("Origin is required.", statusCode: 400);
        if (!Enum.TryParse<LedgerPreset>(req.Preset, ignoreCase: true, out var preset))
            return Results.Problem($"Unknown ledger preset '{req.Preset}'.", statusCode: 400);

        if (sessionManager.Session is not { } session)
        {
            logger.LogError("No session when tracking {Origin}", req.Origin);
            return Results.Problem("No session loaded.", statusCode: 503);
        }

        try
        {
            await trackService.TrackAsync(session, req.Origin, preset);
            return Results.Ok(new TrackResponse(req.Origin));
        }
        catch (KeyNotFoundException ex)
        {
            logger.LogWarning(ex, "No loaded plugin has origin {Origin} to track", req.Origin);
            return Results.Problem(ex.Message, statusCode: 404);
        }
        catch (LedgerAlreadyTrackedException ex)
        {
            logger.LogWarning(ex, "Refused to re-track {Origin}", req.Origin);
            return Results.Problem(ex.Message, statusCode: 409);
        }
        catch (GitUnavailableException ex)
        {
            logger.LogError(ex, "git unavailable while tracking {Origin}", req.Origin);
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }
}

public record CreatePluginRequest(string Name);

public record LoadPluginRequest(string Path, string Origin);

public record UnloadPluginRequest(string Plugin, string Origin);

// #279: Path and Origin are the copy the plugin name resolves to *now*, resolved by Mod
// Management. Plugin is the filename, which is what the load order names and what does not change.
public record RereadPluginRequest(string Plugin, string Path, string Origin);

// #414: Preset is the wire-safe string form of LedgerPreset ("Edits"/"Everything") — Plugin/Path
// aren't needed here, unlike RereadPluginRequest's: Origin alone is enough for TrackService to
// resolve every plugin sharing that mod folder.
public record TrackRequest(string Origin, string Preset);

public record TrackResponse(string Origin);
