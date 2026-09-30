using MEditService.Commands;
using MEditService.LoadOrder;

namespace MEditService.Http.Endpoints;

public static class LoadOrderEndpoints
{
    private const string Tag = "LoadOrder";

    public static IEndpointRouteBuilder MapLoadOrderEndpoints(this IEndpointRouteBuilder app)
    {
        // ADR-0013 invariant 1: the one way the load order reaches Editing. PUT, because it is
        // state, not a command: sending the same body twice changes nothing.
        app.MapPut("/load-order", PutLoadOrder)
            .WithName("PutLoadOrder")
            .WithTags(Tag)
            .WithDescription(
                "Reconciles the load order against this snapshot (ADR-0013): every plugin file in " +
                "the instance, each with its origin and path, and the active plugins in load order, " +
                "as Mod Management decided them. Plugins new to the snapshot are opened and " +
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
        // ADR-0009 invariant 3: the MO2 instance root is what the index file is keyed on, so a
        // snapshot that cannot name one has nowhere to keep its rows — a bad request, not a
        // degraded reconcile.
        if (!Directory.Exists(req.InstanceRoot))
            return Results.Problem($"Instance root not found: {req.InstanceRoot}", statusCode: 400);

        if (WriteEndpointMapping.ParseGameRelease(req.GameRelease, out var gameRelease) is { } releaseErr) return releaseErr;

        if (req.Plugins is not { } plugins
            || plugins.Any(p => string.IsNullOrEmpty(p.Name) || string.IsNullOrEmpty(p.Path) || string.IsNullOrEmpty(p.Origin)))
        {
            return Results.Problem("Each plugin entry must have a non-empty Name, Path, and Origin.", statusCode: 400);
        }
        // ADR-0013 invariant 3: which plugins are active is Mod Management's to state, never
        // defaulted here.
        if (req.Active is not { } active)
            return Results.Problem("The snapshot must state its active plugins.", statusCode: 400);
        if (ActiveRefusal(plugins, active) is { } refusal)
            return Results.Problem(refusal, statusCode: 400);

        try
        {
            var result = handler.Put(
                req.GameDirectory, req.InstanceRoot, gameRelease,
                [.. plugins.Select(p => new RegisteredPlugin(p.Name, p.Origin, p.Path))], active);
            return result.Applied ? Results.Ok(new LoadOrderResponse(true, result.Version)) : WriteEndpointMapping.Refusal(result);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogError(ex, "Failed to apply the load order for {InstanceRoot}", req.InstanceRoot);
            return WriteEndpointMapping.WriteFailure(ex.Message);
        }
    }

    // ADR-0012: the game loads one file per name, so an active list naming two answers wrong
    // everywhere a FormID or a winner is read by filename.
    private static string? ActiveRefusal(IReadOnlyList<LoadOrderPlugin> plugins, IReadOnlyList<PluginAddress> active)
    {
        var sent = plugins.Select(p => new PluginAddress(p.Name, p.Origin)).ToHashSet(PluginAddress.Comparer);
        var stray = active.Where(a => !sent.Contains(a)).Select(a => $"{a.Name} from {a.Origin}").FirstOrDefault();
        if (stray is not null) return $"The active plugin {stray} is not a plugin in the snapshot.";

        var contested = active
            .GroupBy(a => a.Name, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(g => g.Count() > 1);
        return contested is null
            ? null
            : $"The snapshot names more than one active {contested.Key}: " +
              $"{string.Join(", ", contested.Select(a => a.Origin))}. The game loads one file per name.";
    }
}
