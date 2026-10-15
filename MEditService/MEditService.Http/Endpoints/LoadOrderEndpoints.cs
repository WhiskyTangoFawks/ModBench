using MEditService.Commands;
using MEditService.Commands.Build;
using MEditService.LoadOrder;

namespace MEditService.Http.Endpoints;

internal static class LoadOrderEndpoints
{
    private const string Tag = "LoadOrder";

    public static IEndpointRouteBuilder MapLoadOrderEndpoints(this IEndpointRouteBuilder app)
    {
        // ADR-0013. PUT, because sending the same body twice changes nothing.
        app.MapPut("/load-order", PutLoadOrder)
            .WithName("PutLoadOrder")
            .WithTags(Tag)
            .WithDescription(
                "Reconciles the load order against this snapshot (ADR-0013): every plugin file in " +
                "the instance, each with its origin, path, provider, strings files and archives, the active plugins in load order, " +
                "the plugins loaded with no line, the archives the game loads and the loose strings files it reads, as Mod Management decided them. " +
                "Every archive and strings file carries its stamp. It names each mod, by its folder with the files of it the repository " +
                "commits, and the stat cache's folder, and each mod whose status then changed is pushed as mod-status-changed. " +
                "Plugins new to the snapshot are opened and " +
                "registered (indexed only if never seen), plugins absent from it are unregistered, " +
                "plugins whose load index moved are re-registered SQL-only; then one winner sweep. " +
                "Answers as soon as the snapshot is applied; the sweep runs after, reported on " +
                "GET /load-order/status and the load-order-status notification.")
            .Produces<LoadOrderResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500);

        return app;
    }

    internal static IResult PutLoadOrder(LoadOrderRequest req, PutLoadOrderHandler handler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(LoadOrderEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received PutLoadOrder for {InstanceRoot} ({Count} plugins)", req.InstanceRoot, req.Plugins?.Count ?? 0);
        }
        if (EndpointMapping.ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;

        if (RegisteredPluginsOf(req.Plugins) is not { } registered)
        {
            return Results.Problem("Each plugin entry must have a non-empty Name, Path, Origin and Provider, and its archives and strings files.", statusCode: 400);
        }
        // Never defaulted here (ADR-0013).
        if (req.Active is not { } active || req.LoadedWithNoLine is not { } loadedWithNoLine
            || req.Archives is not { } archives || req.StringsFiles is not { } stringsFiles || !AllStamped(archives, stringsFiles)
            || !ModsByFolder.AreWhole(req.Mods) || string.IsNullOrWhiteSpace(req.StatCache))
        {
            return Results.Problem("The snapshot must state its active plugins, those loaded with no line, its archives, its strings files, its mods and the stat cache's folder.", statusCode: 400);
        }

        var result = handler.Put(
            req.GameDirectory, req.InstanceRoot, gameRelease,
            registered, active, loadedWithNoLine, archives, stringsFiles,
            new SnapshotMods(req.Mods, req.StatCache));
        return result.Applied ? Results.Ok(new LoadOrderResponse(true, result.Version)) : EndpointMapping.Refusal(result);
    }

    private static bool AllStamped(IReadOnlyList<StampedFile> archives, IReadOnlyList<StampedFile> stringsFiles) =>
        archives.Concat(stringsFiles).All(file => !string.IsNullOrEmpty(file?.Path) && file.Stamp is not null);

    private static List<RegisteredPlugin>? RegisteredPluginsOf(IReadOnlyList<LoadOrderPlugin>? plugins)
    {
        if (plugins is null) return null;
        List<RegisteredPlugin> registered = [];
        foreach (var p in plugins)
        {
            if (string.IsNullOrEmpty(p.Name) || string.IsNullOrEmpty(p.Path) || string.IsNullOrEmpty(p.Origin)
                || p.Provider?.ToProvider() is not { } provider || p.Archives is not { } archives || p.StringsFiles is not { } stringsFiles
                || !AllStamped(archives, stringsFiles))
            {
                return null;
            }
            registered.Add(new RegisteredPlugin(
                p.Name, p.Origin, p.Path, provider, p.Line is { } line ? new PluginLine(line, p.LineNamesIt) : null, new PluginStrings(archives, stringsFiles)));
        }
        return registered;
    }
}
