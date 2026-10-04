using MEditService.Queries;

namespace MEditService.Http.Endpoints;

public static class WorldspaceEndpoints
{
    public static IEndpointRouteBuilder MapWorldspaceEndpoints(this IEndpointRouteBuilder app, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(WorldspaceEndpoints));

        app.MapGet("/plugins/{plugin}/worldspaces", (string plugin, string? origin, IWorldspaceQueryService svc) =>
            GetWorldspaces(plugin, origin, svc, logger))
        .WithName("GetWorldspaces")
        .WithTags("Worldspaces")
        .Produces<IReadOnlyList<WorldspaceSummary>>()
        .ProducesProblem(400)
        .ProducesProblem(500);

        app.MapGet("/plugins/{plugin}/worldspaces/{formKey}/blocks", (string plugin, string formKey, string? origin, IWorldspaceQueryService svc) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetWorldspaceBlocks for {Plugin} {FormKey} ({Origin})", plugin, formKey, origin);
            }
            if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
            var decodedPlugin = Uri.UnescapeDataString(plugin);
            var decodedFk = Uri.UnescapeDataString(formKey);
            try
            {
                return Results.Ok(svc.GetWorldspaceBlocks(decodedPlugin, decodedFk, origin));
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                logger.LogError(ex, "Failed to get worldspace blocks for {Plugin} {FormKey}", decodedPlugin, decodedFk);
                return Results.Problem(ex.Message);
            }
        })
        .WithName("GetWorldspaceBlocks")
        .WithTags("Worldspaces")
        .Produces<WorldspaceBlocks>()
        .ProducesProblem(400)
        .ProducesProblem(500);

        app.MapGet("/plugins/{plugin}/cells/{formKey}/children", (string plugin, string formKey, string? origin, IWorldspaceQueryService svc) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetCellChildRecords for {Plugin} {FormKey} ({Origin})", plugin, formKey, origin);
            }
            if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
            var decodedPlugin = Uri.UnescapeDataString(plugin);
            var decodedFk = Uri.UnescapeDataString(formKey);
            try
            {
                return Results.Ok(svc.GetCellChildRecords(decodedPlugin, decodedFk, origin));
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                logger.LogError(ex, "Failed to get cell references for {Plugin} {FormKey}", decodedPlugin, decodedFk);
                return Results.Problem(ex.Message);
            }
        })
        .WithName("GetCellChildRecords")
        .WithTags("Worldspaces")
        .Produces<CellChildRecords>()
        .ProducesProblem(400)
        .ProducesProblem(500);

        app.MapGet("/plugins/{plugin}/interior-cells", (string plugin, string? origin, IWorldspaceQueryService svc) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetInteriorCells for {Plugin} ({Origin})", plugin, origin);
            }
            if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
            var decoded = Uri.UnescapeDataString(plugin);
            try
            {
                return Results.Ok(svc.GetInteriorCells(decoded, origin));
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                logger.LogError(ex, "Failed to get interior cells for {Plugin}", decoded);
                return Results.Problem(ex.Message);
            }
        })
        .WithName("GetInteriorCells")
        .WithTags("Worldspaces")
        .Produces<IReadOnlyList<InteriorCellBlock>>()
        .ProducesProblem(400)
        .ProducesProblem(500);

        return app;
    }

    internal static IResult GetWorldspaces(string plugin, string? origin, IWorldspaceQueryService svc, ILogger logger)
    {
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received GetWorldspaces for {Plugin} ({Origin})", plugin, origin);
        }
        if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
        var decoded = Uri.UnescapeDataString(plugin);
        try
        {
            return Results.Ok(svc.GetWorldspaces(decoded, origin));
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogError(ex, "Failed to get worldspaces for {Plugin}", decoded);
            return Results.Problem(ex.Message);
        }
    }
}
