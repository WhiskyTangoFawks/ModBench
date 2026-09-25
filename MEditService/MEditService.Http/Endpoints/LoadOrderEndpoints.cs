using MEditService.Commands;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;

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
                "the instance — winning and overridden, listed and unlisted — each with its " +
                "plugins.txt slot (null when no line names it), its * prefix and whether the Mod " +
                "override order resolves the name to it. Plugins new to the load order are opened " +
                "and registered (indexed only if never seen), plugins absent from the snapshot are " +
                "unregistered, moved plugins are re-registered SQL-only; then one winner sweep. " +
                "Vanilla masters are prepended by the backend and need not be listed. Answers as " +
                "soon as the snapshot is applied; the sweep runs after, reported on " +
                "GET /load-order/status and the load-order-status notification.")
            .Produces<LoadOrderResponse>()
            .ProducesProblem(400)
            .ProducesProblem(500);

        // ADR-0013 invariant 2: answered from the game directory alone, with no load order held.
        // Mod Management asks it while reconciling plugins.txt, which is what a PUT is built from.
        app.MapGet("/implicit-masters", GetImplicitMasters)
            .WithName("GetImplicitMasters")
            .WithTags(Tag)
            .WithDescription(
                "The plugin filenames this install loads without a plugins.txt line of their own: " +
                "the release's implicit masters present in the given Data folder, then that " +
                "folder's Creation Club catalog. Load order.")
            .Produces<IReadOnlyList<string>>()
            .ProducesProblem(400);

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

        // Every registration fact is Mod Management's to state, never defaulted here: a missing
        // bool silently bound to false would make every plugin non-participating.
        if (req.Plugins is not { } plugins
            || plugins.Any(p => string.IsNullOrEmpty(p.Name) || string.IsNullOrEmpty(p.Path) || string.IsNullOrEmpty(p.Origin) || p.Enabled is null || p.Winning is null))
        {
            return Results.Problem("Each plugin entry must have a non-empty Name, Path, and Origin, and must state Enabled and Winning.", statusCode: 400);
        }

        try
        {
            var entries = plugins
                .Select(p => new LoadOrderEntry(p.Name, p.Path, p.Origin, p.Slot,
                    p.Enabled ?? throw new InvalidOperationException("Expected a validated plugin to state Enabled."),
                    p.Winning ?? throw new InvalidOperationException("Expected a validated plugin to state Winning.")))
                .ToList();
            var result = handler.Put(req.GameDirectory, req.InstanceRoot, gameRelease, entries);
            return result.Applied ? Results.Ok(new LoadOrderResponse(true, result.Version)) : WriteEndpointMapping.Refusal(result);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogError(ex, "Failed to apply the load order for {InstanceRoot}", req.InstanceRoot);
            return WriteEndpointMapping.WriteFailure(ex.Message);
        }
    }

    // An absent directory is a bad request, not an empty answer: "no implicit masters" and "that
    // folder isn't there" want opposite responses from the caller.
    internal static IResult GetImplicitMasters(string gameDirectory, string gameRelease, IPluginAdapter adapter)
    {
        if (!Directory.Exists(gameDirectory))
            return Results.Problem($"Game directory not found: {gameDirectory}", statusCode: 400);
        if (WriteEndpointMapping.ParseGameRelease(gameRelease, out var release) is { } releaseErr) return releaseErr;
        return Results.Ok(adapter.ImplicitPluginsIn(gameDirectory, release));
    }
}
