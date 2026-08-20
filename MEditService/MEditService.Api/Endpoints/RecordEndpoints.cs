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
        .ProducesProblem(422)
        // The ledger file is not ours exclusively — an I/O failure mid-edit is a real answer this
        // route can give, so it is declared like every other (endpoint invariant).
        .ProducesProblem(500)
        .ProducesProblem(503);

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

        // The write path touches a file inside a live git working tree that Modbench does not own
        // exclusively (root CLAUDE.md) — it can be locked by another tool, replaced, or sitting on a
        // mount that just went away — and there is no global exception middleware to shape what
        // comes back. Every sibling write endpoint here catches and maps rather than letting one
        // escape as a bodyless 500 that a client cannot tell apart from the backend having died.
        // LedgerFreshness already degrades on this same exception set on the read side, so this is
        // the write side's equivalent rather than a new policy.
        try
        {
            var result = edits.EditField(
                new PluginKey(request.Plugin, request.Origin), decoded, request.FieldPath, request.Value);

            return result.Applied
                ? Results.Ok(new RecordFieldEditResponse(true, decoded, request.FieldPath))
                : Refusal(result);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not write the ledger file while editing {FormKey}.{FieldPath}",
                decoded, request.FieldPath);
            return Results.Problem($"Could not write the ledger file for {decoded}: {ex.Message}", statusCode: 500);
        }
        catch (InvalidOperationException ex)
        {
            // 503, matching every sibling's own mapping for it: the session went away underneath the
            // request, which is a "not right now", never a bad request.
            logger.LogError(ex, "No usable session while editing {FormKey}.{FieldPath}", decoded, request.FieldPath);
            return Results.Problem(ex.Message, statusCode: 503);
        }
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
