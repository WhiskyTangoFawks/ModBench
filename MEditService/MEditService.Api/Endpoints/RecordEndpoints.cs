using MEditService.Core.Queries;

namespace MEditService.Api.Endpoints;

public static class RecordEndpoints
{
    public static IEndpointRouteBuilder MapRecordEndpoints(this IEndpointRouteBuilder app, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(RecordEndpoints));

        app.MapGet("/records", (
            IRecordQueryService svc,
            string? plugin,
            string? type,
            string? search,
            int limit = 50,
            int offset = 0) =>
        {
            logger.LogInformation("Received GetRecords for {Plugin} {Type} {Search}", plugin, type, search);
            var result = svc.GetRecords(type, plugin, search, limit, offset);
            return Results.Ok(result);
        })
        .WithName("GetRecords")
        .WithTags("Records")
        .Produces<PagedResult<RecordSummary>>();

        app.MapGet("/records/{formKey}", (string formKey, IRecordQueryService svc) =>
        {
            logger.LogInformation("Received GetRecord for {FormKey}", formKey);
            var decoded = Uri.UnescapeDataString(formKey);
            var detail = svc.GetRecord(decoded);
            return detail is null ? Results.NotFound() : Results.Ok(detail);
        })
        .WithName("GetRecord")
        .WithTags("Records")
        .Produces<RecordDetail>()
        .ProducesProblem(404);

        app.MapGet("/records/{formKey}/compare", (string formKey, IRecordQueryService svc) =>
        {
            logger.LogInformation("Received CompareRecord for {FormKey}", formKey);
            var decoded = Uri.UnescapeDataString(formKey);
            var result = svc.GetCompare(decoded);
            return result is null ? Results.NotFound() : Results.Ok(result);
        })
        .WithName("CompareRecord")
        .WithTags("Records")
        .Produces<CompareResult>()
        .ProducesProblem(404);

        app.MapGet("/records/{formKey}/references", (string formKey, IRecordQueryService svc) =>
            GetReferences(formKey, svc, logger))
        .WithName("GetReferences")
        .WithTags("Records")
        .Produces<IReadOnlyList<ReferenceResult>>()
        .ProducesProblem(500);

        return app;
    }

    internal static IResult GetReferences(string formKey, IRecordQueryService svc, ILogger logger)
    {
        logger.LogInformation("Received GetReferences for {FormKey}", formKey);
        var decoded = Uri.UnescapeDataString(formKey);
        try
        {
            var results = svc.GetReferences(decoded);
            return Results.Ok(results);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to get references for {FormKey}", decoded);
            return Results.Problem(ex.Message);
        }
    }
}
