using MEditService.Index.Queries;

namespace MEditService.Http.Endpoints;

internal static class WorldspaceEndpoints
{
    public static IEndpointRouteBuilder MapWorldspaceEndpoints(this IEndpointRouteBuilder app, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(WorldspaceEndpoints));

        app.MapGet("/plugins/{plugin}/worldspaces", (string plugin, string? origin, IQueries svc) =>
            GetWorldspaces(plugin, origin, svc, logger))
        .WithName("GetWorldspaces")
        .WithTags("Worldspaces")
        .Produces<IReadOnlyList<WorldspaceSummary>>()
        .ProducesProblem(400)
        .ProducesProblem(500)
        .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/worldspaces/{formKey}/blocks", (string plugin, string formKey, string? origin, IQueries svc) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetWorldspaceBlocks for {Plugin} {FormKey} ({Origin})", plugin, formKey, origin);
            }
            if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
            var address = WriteEndpointMapping.PluginAddressOf(plugin, origin);
            var decodedFk = Uri.UnescapeDataString(formKey);
            return QueryEndpointMapping.Ok(svc.GetWorldspaceBlocks(address, decodedFk));
        })
        .WithName("GetWorldspaceBlocks")
        .WithTags("Worldspaces")
        .Produces<WorldspaceBlocks>()
        .ProducesProblem(400)
        .ProducesProblem(500)
        .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/cells/{formKey}/children", (string plugin, string formKey, string? origin, IQueries svc) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetCellChildRecords for {Plugin} {FormKey} ({Origin})", plugin, formKey, origin);
            }
            if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
            var address = WriteEndpointMapping.PluginAddressOf(plugin, origin);
            var decodedFk = Uri.UnescapeDataString(formKey);
            return QueryEndpointMapping.Ok(svc.GetCellChildRecords(address, decodedFk));
        })
        .WithName("GetCellChildRecords")
        .WithTags("Worldspaces")
        .Produces<CellChildRecords>()
        .ProducesProblem(400)
        .ProducesProblem(500)
        .ProducesProblem(503);

        app.MapGet("/plugins/{plugin}/interior-cells", (string plugin, string? origin, IQueries svc) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetInteriorCells for {Plugin} ({Origin})", plugin, origin);
            }
            if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
            var address = WriteEndpointMapping.PluginAddressOf(plugin, origin);
            return QueryEndpointMapping.Ok(svc.GetInteriorCells(address));
        })
        .WithName("GetInteriorCells")
        .WithTags("Worldspaces")
        .Produces<IReadOnlyList<InteriorCellBlock>>()
        .ProducesProblem(400)
        .ProducesProblem(500)
        .ProducesProblem(503);

        return app;
    }

    internal static IResult GetWorldspaces(string plugin, string? origin, IQueries svc, ILogger logger)
    {
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received GetWorldspaces for {Plugin} ({Origin})", plugin, origin);
        }
        if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
        var address = WriteEndpointMapping.PluginAddressOf(plugin, origin);
        return QueryEndpointMapping.Ok(svc.GetWorldspaces(address));
    }
}
