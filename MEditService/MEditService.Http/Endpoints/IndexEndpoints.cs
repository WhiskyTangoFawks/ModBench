using MEditService.LoadOrder;
using MEditService.Index;

namespace MEditService.Http.Endpoints;

/// <summary>What one reconcile request found. PluginsRebuilt names the copies that had moved too
/// far for a per-key refresh and were re-derived whole, whose rows RowsChanged cannot name.</summary>
public sealed record ReconcileResponse(
    int Plugins, int RowsChanged, int PluginsRebuilt, long Sequence, IReadOnlyList<string> Failures);

public static class IndexEndpoints
{
    private const string Tag = "Index";

    public static IEndpointRouteBuilder MapIndexEndpoints(this IEndpointRouteBuilder app)
    {
        // ADR-0015 invariants 2 and 4: the Index's second way of learning of change. POST because it
        // is a gesture with an effect, not state.
        app.MapPost("/index/reconcile", Reconcile)
            .WithName("ReconcileIndex")
            .WithTags(Tag)
            .WithDescription(
                "Validates the index by content hash against the systems of record its rows came " +
                "from — each source document at both refs for a tracked copy, the binary for an " +
                "untracked one — and refreshes what differs. Name one copy with plugin and origin " +
                "together, or omit both to check every registered copy. Rows it changes are " +
                "published on /notifications/stream as they land.")
            .Produces<ReconcileResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(503)
            .ProducesProblem(500);

        return app;
    }

    private static IResult Reconcile(
        IndexProjector index, ILoggerFactory loggerFactory, string? plugin = null, string? origin = null)
    {
        var logger = loggerFactory.CreateLogger(nameof(IndexEndpoints));
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received ReconcileIndex for {Plugin} ({Origin})", plugin ?? "every plugin", origin);
        }

        // ADR-0012: a copy is (origin, plugin) together, so half an identity names nothing.
        if (string.IsNullOrEmpty(plugin) != string.IsNullOrEmpty(origin))
            return Results.Problem("Name a copy with both plugin and origin, or neither to check every copy.", statusCode: 400);

        PluginKey? key = string.IsNullOrEmpty(plugin) ? (PluginKey?)null : new PluginKey(plugin, origin!);
        if (key is { } named && !index.Registers(named))
            return Results.Problem($"No registered copy of '{plugin}' from '{origin}'.", statusCode: 404);

        try
        {
            var reports = index.ValidateIndex(key);
            return Results.Ok(new ReconcileResponse(
                reports.Count,
                reports.Sum(r => r.ChangedKeys.Count),
                reports.Count(r => r.NeedsRebuild),
                index.Sequence,
                [.. reports.SelectMany(r => r.Failures)]));
        }
        catch (NoLoadOrderException ex)
        {
            logger.LogWarning(ex, "No load order when reconciling the index");
            return WriteEndpointMapping.NoLoadOrder(ex);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to reconcile the index");
            return Results.Problem(ex.Message, statusCode: 500);
        }
    }
}
