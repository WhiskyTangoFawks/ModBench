using MEditService.Core.Queries;

namespace MEditService.Api.Endpoints;

public static class RecordEndpoints
{
    public static IEndpointRouteBuilder MapRecordEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/records", (
            IRecordQueryService svc,
            string? plugin,
            string? type,
            string? search,
            int limit = 50,
            int offset = 0) =>
        {
            var result = svc.GetRecords(type, plugin, search, limit, offset);
            return Results.Ok(result);
        })
        .WithName("GetRecords")
        .WithTags("Records");

        app.MapGet("/records/{formKey}", (string formKey, IRecordQueryService svc) =>
        {
            var decoded = Uri.UnescapeDataString(formKey);
            var detail = svc.GetRecord(decoded);
            return detail is null ? Results.NotFound() : Results.Ok(detail);
        })
        .WithName("GetRecord")
        .WithTags("Records");

        app.MapGet("/records/{formKey}/compare", (string formKey, IRecordQueryService svc) =>
        {
            var decoded = Uri.UnescapeDataString(formKey);
            var result = svc.GetCompare(decoded);
            return result is null ? Results.NotFound() : Results.Ok(result);
        })
        .WithName("CompareRecord")
        .WithTags("Records");

        return app;
    }
}
