using MEditService.RecordIndex.Queries;

namespace MEditService.Http.Endpoints;

internal static class WorldspaceEndpoints
{
    public static IEndpointRouteBuilder MapWorldspaceEndpoints(this IEndpointRouteBuilder app, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(WorldspaceEndpoints));

        app.MapGet("/plugins/{plugin}/worldspaces", (string plugin, string? origin, IQueries svc, CancellationToken aborted) =>
            GetWorldspaces(plugin, origin, svc, logger, aborted))
        .WithName("GetWorldspaces")
        .WithTags("Worldspaces")
        .Produces<IReadOnlyList<WorldspaceSummary>>()
        .ProducesProblem(400)
        .ProducesProblem(500)
        .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/worldspaces/{formKey}/blocks", async (
            string plugin, string formKey, string? origin, IQueries svc, CancellationToken aborted) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetWorldspaceBlocks for {Plugin} {FormKey} ({Origin})", plugin, formKey, origin);
            }
            if (!EndpointMapping.PluginAt(plugin, origin, out var address, out var refused)) return refused;
            var decodedFk = Uri.UnescapeDataString(formKey);
            return EndpointMapping.Ok(await svc.GetWorldspaceBlocks(address, decodedFk, aborted));
        })
        .WithName("GetWorldspaceBlocks")
        .WithTags("Worldspaces")
        .Produces<WorldspaceBlocks>()
        .ProducesProblem(400)
        .ProducesProblem(500)
        .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/cells/{formKey}/children", async (
            string plugin, string formKey, string? origin, IQueries svc, CancellationToken aborted) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetCellChildRecords for {Plugin} {FormKey} ({Origin})", plugin, formKey, origin);
            }
            if (!EndpointMapping.PluginAt(plugin, origin, out var address, out var refused)) return refused;
            var decodedFk = Uri.UnescapeDataString(formKey);
            return EndpointMapping.Ok(await svc.GetCellChildRecords(address, decodedFk, aborted));
        })
        .WithName("GetCellChildRecords")
        .WithTags("Worldspaces")
        .Produces<CellChildRecords>()
        .ProducesProblem(400)
        .ProducesProblem(500)
        .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/interior-cells", async (string plugin, string? origin, IQueries svc, CancellationToken aborted) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetInteriorCells for {Plugin} ({Origin})", plugin, origin);
            }
            if (!EndpointMapping.PluginAt(plugin, origin, out var address, out var refused)) return refused;
            return EndpointMapping.Ok(await svc.GetInteriorCells(address, aborted));
        })
        .WithName("GetInteriorCells")
        .WithTags("Worldspaces")
        .Produces<IReadOnlyList<InteriorCellBlock>>()
        .ProducesProblem(400)
        .ProducesProblem(500)
        .ProducesProblem(503);

        return app;
    }

    internal static async Task<IResult> GetWorldspaces(string plugin, string? origin, IQueries svc, ILogger logger, CancellationToken aborted)
    {
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received GetWorldspaces for {Plugin} ({Origin})", plugin, origin);
        }
        if (!EndpointMapping.PluginAt(plugin, origin, out var address, out var refused)) return refused;
        return EndpointMapping.Ok(await svc.GetWorldspaces(address, aborted));
    }
}
