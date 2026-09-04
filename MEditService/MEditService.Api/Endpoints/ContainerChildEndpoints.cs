using MEditService.Core.Queries;

namespace MEditService.Api.Endpoints;

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
            var decodedPlugin = Uri.UnescapeDataString(plugin);
            var decodedFk = Uri.UnescapeDataString(formKey);
            try
            {
                return Results.Ok(svc.GetChildren(decodedPlugin, decodedFk, origin));
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to get container children for {Plugin} {FormKey}", decodedPlugin, decodedFk);
                return Results.Problem(ex.Message);
            }
        })
        .WithName("GetContainerChildren")
        .WithTags("Records")
        .Produces<IReadOnlyList<ContainerChildSummary>>()
        .ProducesProblem(500);

        return app;
    }
}
