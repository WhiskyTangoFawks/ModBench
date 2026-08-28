using MEditService.Core.Queries;

namespace MEditService.Api.Endpoints;

/// <summary>
/// The container-child read (#424) — deliberately its own file rather than folded into
/// <see cref="WorldspaceEndpoints"/>: that file is named for a different domain concept
/// (spatial/cell containment), while <see cref="IContainerChildQueryService"/> is container-type-
/// agnostic even though only Quest/DialogTopic rows call it today.
/// </summary>
public static class ContainerChildEndpoints
{
    public static IEndpointRouteBuilder MapContainerChildEndpoints(this IEndpointRouteBuilder app, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(ContainerChildEndpoints));

        app.MapGet("/plugins/{plugin}/records/{formKey}/children", (string plugin, string formKey, string? origin, IContainerChildQueryService svc) =>
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
