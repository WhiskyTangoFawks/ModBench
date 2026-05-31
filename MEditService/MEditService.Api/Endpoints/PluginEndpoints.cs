using MEditService.Core.Queries;
using MEditService.Core.Session;

namespace MEditService.Api.Endpoints;

public static class PluginEndpoints
{
    public static IEndpointRouteBuilder MapPluginEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/plugins", (IRecordQueryService svc) => Results.Ok(svc.GetPlugins()))
            .WithName("GetPlugins")
            .WithTags("Plugins")
            .Produces<IReadOnlyList<PluginResponse>>();

        app.MapGet("/record-types", (IRecordQueryService svc) => Results.Ok(svc.GetRecordTypes()))
            .WithName("GetRecordTypes")
            .WithTags("Records")
            .Produces<IReadOnlyList<string>>();

        app.MapGet("/plugins/{plugin}/record-types", (string plugin, IRecordQueryService svc) =>
            Results.Ok(svc.GetPluginRecordTypes(Uri.UnescapeDataString(plugin))))
            .WithName("GetPluginRecordTypes")
            .WithTags("Plugins")
            .Produces<IReadOnlyList<PluginRecordTypeCount>>();

        app.MapPost("/plugins/create", (CreatePluginRequest req, ISessionManager sessionManager) =>
        {
            if (string.IsNullOrWhiteSpace(req.Name))
                return Results.Problem("Plugin name is required.", statusCode: 400);

            try
            {
                var plugin = sessionManager.CreatePlugin(req.Name);
                return Results.Ok(plugin);
            }
            catch (ArgumentException ex)
            {
                return Results.Problem(ex.Message, statusCode: 400);
            }
            catch (System.IO.IOException ex)
            {
                return Results.Problem(ex.Message, statusCode: 409);
            }
            catch (InvalidOperationException ex)
            {
                return Results.Problem(ex.Message, statusCode: 503);
            }
        })
        .WithName("CreatePlugin")
        .WithTags("Plugins")
        .Produces<PluginResponse>()
        .ProducesProblem(400)
        .ProducesProblem(409);

        return app;
    }
}

public record CreatePluginRequest(string Name);
