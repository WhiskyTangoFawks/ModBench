using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;

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
            string? origin = null,
            int limit = 50,
            int offset = 0) =>
        {
            logger.LogInformation("Received GetRecords for {Plugin} ({Origin}) {Type} {Search}", plugin, origin, type, search);
            var result = svc.GetRecords(type, plugin, search, limit, offset, origin);
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

        // #415 / ADR-0041: the single write path's one door. Scripts and agents (ADR-0024's ordinary
        // HTTP clients) reach the same RecordEditService the UI does — there is no second write path,
        // which is exactly why the untracked refusal is expressible here at all.
        app.MapPost("/records/{formKey}/field", (
            string formKey, RecordFieldEditRequest request, RecordEditService edits) =>
            EditField(formKey, request, edits, logger))
        .WithName("EditRecordField")
        .WithTags("Records")
        .Produces<RecordFieldEditResponse>()
        .ProducesProblem(400)
        .ProducesProblem(404)
        .ProducesProblem(409)
        .ProducesProblem(422);

        return app;
    }

    internal static IResult EditField(
        string formKey, RecordFieldEditRequest request, RecordEditService edits, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        logger.LogInformation(
            "Received EditRecordField for {FormKey}.{FieldPath} in {Plugin} ({Origin})",
            decoded, request.FieldPath, request.Plugin, request.Origin);

        if (string.IsNullOrWhiteSpace(request.Plugin) || string.IsNullOrWhiteSpace(request.Origin))
            return Results.Problem("Plugin name and origin are required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(request.FieldPath))
            return Results.Problem("A field path is required.", statusCode: 400);

        var result = edits.EditField(
            new PluginKey(request.Plugin, request.Origin), decoded, request.FieldPath, request.Value);

        return result.Applied
            ? Results.Ok(new RecordFieldEditResponse(true, decoded, request.FieldPath))
            : Refusal(result);
    }

    /// <summary>
    /// A refused edit as ProblemDetails, carrying the <see cref="RecordEditRefusal"/> as a
    /// <c>refusal</c> extension beside the human-readable detail — AC5's "typed refusal mirroring the
    /// UI's". The status code says what <i>kind</i> of problem it is, so an ordinary HTTP client
    /// behaves sanely without knowing our vocabulary; the extension says exactly which one, so an
    /// agent never has to match on prose (ADR-0026).
    /// </summary>
    private static IResult Refusal(RecordEditResult result) => Results.Problem(
        detail: result.Message,
        statusCode: result.Refusal switch
        {
            // Not-editable-at-all is a state conflict: the request is well-formed, and the answer is
            // "not while this plugin is untracked".
            RecordEditRefusal.PluginNotTracked or RecordEditRefusal.PluginHasNoModFolder => 409,
            RecordEditRefusal.RecordNotFound or RecordEditRefusal.FieldNotFound => 404,
            // Well-formed, addressed at something real, and still not something we will write.
            _ => 422,
        },
        extensions: new Dictionary<string, object?> { ["refusal"] = result.Refusal.ToString() });

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
