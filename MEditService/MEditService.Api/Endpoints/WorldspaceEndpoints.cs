using MEditService.Core.Queries;

namespace MEditService.Api.Endpoints;

public static class WorldspaceEndpoints
{
    public static IEndpointRouteBuilder MapWorldspaceEndpoints(this IEndpointRouteBuilder app, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(WorldspaceEndpoints));

        app.MapGet("/plugins/{plugin}/worldspaces", (string plugin, IWorldspaceQueryService svc) =>
        {
            var decoded = Uri.UnescapeDataString(plugin);
            try
            {
                return Results.Ok(svc.GetWorldspaces(decoded));
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to get worldspaces for {Plugin}", decoded);
                return Results.Problem(ex.Message);
            }
        })
        .WithName("GetWorldspaces")
        .WithTags("Worldspaces")
        .Produces<IReadOnlyList<WorldspaceSummary>>()
        .ProducesProblem(500);

        app.MapGet("/plugins/{plugin}/worldspaces/{formKey}/blocks", (string plugin, string formKey, IWorldspaceQueryService svc) =>
        {
            var decodedPlugin = Uri.UnescapeDataString(plugin);
            var decodedFk = Uri.UnescapeDataString(formKey);
            try
            {
                return Results.Ok(svc.GetWorldspaceBlocks(decodedPlugin, decodedFk));
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to get worldspace blocks for {Plugin} {FormKey}", decodedPlugin, decodedFk);
                return Results.Problem(ex.Message);
            }
        })
        .WithName("GetWorldspaceBlocks")
        .WithTags("Worldspaces")
        .Produces<WorldspaceBlocks>()
        .ProducesProblem(500);

        app.MapGet("/plugins/{plugin}/cells/{formKey}/references", (string plugin, string formKey, IWorldspaceQueryService svc) =>
        {
            var decodedPlugin = Uri.UnescapeDataString(plugin);
            var decodedFk = Uri.UnescapeDataString(formKey);
            try
            {
                return Results.Ok(svc.GetCellReferences(decodedPlugin, decodedFk));
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to get cell references for {Plugin} {FormKey}", decodedPlugin, decodedFk);
                return Results.Problem(ex.Message);
            }
        })
        .WithName("GetCellReferences")
        .WithTags("Worldspaces")
        .Produces<CellReferences>()
        .ProducesProblem(500);

        app.MapGet("/plugins/{plugin}/interior-cells", (string plugin, IWorldspaceQueryService svc, int limit = 50, int offset = 0) =>
        {
            var decoded = Uri.UnescapeDataString(plugin);
            try
            {
                return Results.Ok(svc.GetInteriorCells(decoded, limit, offset));
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to get interior cells for {Plugin}", decoded);
                return Results.Problem(ex.Message);
            }
        })
        .WithName("GetInteriorCells")
        .WithTags("Worldspaces")
        .Produces<PagedResult<CellSummary>>()
        .ProducesProblem(500);

        return app;
    }
}
