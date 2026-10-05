using MEditService.Queries;

namespace MEditService.Http.Endpoints;

/// <summary>Its own file rather than part of <see cref="WorldspaceEndpoints"/>: that file is about
/// spatial containment, while the container-child query is container-type-agnostic.</summary>
public static class ContainerChildEndpoints
{
    public static IEndpointRouteBuilder MapContainerChildEndpoints(this IEndpointRouteBuilder app, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(ContainerChildEndpoints));

        app.MapGet("/plugins/{plugin}/records/{formKey}/children", (string plugin, string formKey, string? origin, ContainerChildQueryService svc) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetContainerChildren for {Plugin} {FormKey} ({Origin})", plugin, formKey, origin);
            }
            if (QueryEndpointMapping.MissingOrigin(origin, out var refused)) return refused;
            var address = WriteEndpointMapping.PluginAddressOf(plugin, origin);
            var decodedFk = Uri.UnescapeDataString(formKey);
            try
            {
                return Results.Ok(svc.GetChildren(address, decodedFk));
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                logger.LogError(ex, "Failed to get container children for {Plugin} {FormKey}", address.Name, decodedFk);
                return Results.Problem(ex.Message);
            }
        })
        .WithName("GetContainerChildren")
        .WithTags("Records")
        .Produces<IReadOnlyList<ContainerChildSummary>>()
        .ProducesProblem(400)
        .ProducesProblem(500);

        return app;
    }
}
