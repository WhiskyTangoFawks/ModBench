using MEditService.Commands;
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
                "the instance, each with its origin, path and provider, the active plugins in load order, and " +
                "the plugins loaded with no line, as Mod Management decided them. Plugins new to the snapshot are opened and " +
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
        if (!Directory.Exists(req.GameDirectory))
            return Results.Problem($"Game directory not found: {req.GameDirectory}", statusCode: 400);
        // No instance root, nowhere to keep the rows (ADR-0010).
        if (!Directory.Exists(req.InstanceRoot))
            return Results.Problem($"Instance root not found: {req.InstanceRoot}", statusCode: 400);

        if (WriteEndpointMapping.ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;

        if (RegisteredPluginsOf(req.Plugins) is not { } registered)
        {
            return Results.Problem("Each plugin entry must have a non-empty Name, Path, Origin and Provider.", statusCode: 400);
        }
        // Never defaulted here (ADR-0013).
        if (req.Active is not { } active || req.LoadedWithNoLine is not { } loadedWithNoLine)
            return Results.Problem("The snapshot must state its active plugins and those loaded with no line.", statusCode: 400);

        var result = handler.Put(
            req.GameDirectory, req.InstanceRoot, gameRelease,
            registered, active, loadedWithNoLine);
        return result.Applied ? Results.Ok(new LoadOrderResponse(true, result.Version)) : WriteEndpointMapping.Refusal(result);
    }

    private static List<RegisteredPlugin>? RegisteredPluginsOf(IReadOnlyList<LoadOrderPlugin>? plugins)
    {
        if (plugins is null) return null;
        List<RegisteredPlugin> registered = [];
        foreach (var p in plugins)
        {
            if (string.IsNullOrEmpty(p.Name) || string.IsNullOrEmpty(p.Path) || string.IsNullOrEmpty(p.Origin)
                || p.Provider?.ToProvider() is not { } provider)
            {
                return null;
            }
            registered.Add(new RegisteredPlugin(p.Name, p.Origin, p.Path, provider));
        }
        return registered;
    }
}
