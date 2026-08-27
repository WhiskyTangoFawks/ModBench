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
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetRecords for {Plugin} ({Origin}) {Type} {Search}", plugin, origin, type, search);
            }
            var result = svc.GetRecords(type, plugin, search, limit, offset, origin);
            return Results.Ok(result);
        })
        .WithName("GetRecords")
        .WithTags("Records")
        .Produces<PagedResult<RecordSummary>>();

        app.MapGet("/records/{formKey}", (string formKey, IRecordQueryService svc) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetRecord for {FormKey}", formKey);
            }
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
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received CompareRecord for {FormKey}", formKey);
            }
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
        // The source file is not ours exclusively — an I/O failure mid-edit is a real answer this
        // route can give, so it is declared like every other (endpoint invariant).
        .ProducesProblem(500)
        .ProducesProblem(503);

        // #427: delete-record — the source file goes away and #415's null-Body mechanism takes it
        // from there. Same door, same refusals, same doctrine as EditField above.
        app.MapPost("/records/{formKey}/delete", (
            string formKey, RecordDeleteRequest request, RecordEditService edits) =>
            DeleteRecord(formKey, request, edits, logger))
        .WithName("DeleteRecord")
        .WithSummary("Delete a record as a working-tree change (#415/#427).")
        .WithDescription(
            "Deletes the record's source file — a git-native, null-Body working-tree change (#415's " +
            "mechanism): gone at Effective, still served at Head until the deletion is committed and " +
            "compiled. No reference cascade — a FormLink elsewhere pointing at the deleted record goes " +
            "dangling and surfaces as an ordinary compile diagnostic (ADR-0020), the same as any other " +
            "dangling link.")
        .WithTags("Records")
        .Produces<RecordDeleteResponse>()
        .ProducesProblem(400)
        .ProducesProblem(404)
        .ProducesProblem(409)
        .ProducesProblem(422)
        .ProducesProblem(500)
        .ProducesProblem(503);

        // #427: renumber — a delete+create pair plus the cross-plugin reference cascade (Q5). Same
        // route shape a retired pending-change-era endpoint once had (RetiredEditingWireSurfaceTests
        // used to pin it absent); the summary/description below carry the "same string, new meaning"
        // distinction onto the surface itself, not just a test comment.
        app.MapPost("/records/{formKey}/renumber", (
            string formKey, RecordRenumberRequest request, RecordEditService edits) =>
            RenumberRecord(formKey, request, edits, logger))
        .WithName("RenumberRecord")
        .WithSummary("Renumber a native record's FormKey as a delete+create pair (#427).")
        .WithDescription(
            "Native records only. Rewrites the record under a new FormKey (auto-allocated, both-refs " +
            "collision-safe, or an explicit target) as a working-tree delete of the old source file " +
            "plus a create of the new one, cascading the FormKey change into every tracked plugin that " +
            "references it. Not the retired pending-change-era renumber this same route once served; " +
            "that mechanism (staged rows, no source text, no reference cascade) was removed with " +
            "ADR-0041/#410.")
        .WithTags("Records")
        .Produces<RecordRenumberResponse>()
        .ProducesProblem(400)
        .ProducesProblem(404)
        .ProducesProblem(409)
        .ProducesProblem(422)
        // A partial-cascade failure (Q5(b)) surfaces here too — same shape as every other write
        // path's I/O failure, just with a richer message naming which repos already have dirt.
        .ProducesProblem(500)
        .ProducesProblem(503);

        // #436 (ADR-0041 restoration): Copy as Override Into… — the source record's own bytes,
        // landing under the same FormKey in the destination's working tree. A new route shape (not
        // the retired /records/{formKey}/copy-to/{targetPlugin}, pinned absent by
        // RetiredEditingWireSurfaceTests — that was the staged pending-change copy this ticket does
        // not resurrect).
        app.MapPost("/records/{formKey}/copy-as-override", (
            string formKey, RecordCopyAsOverrideRequest request, RecordEditService edits) =>
            CopyRecordAsOverride(formKey, request, edits, logger))
        .WithName("CopyRecordAsOverride")
        .WithSummary("Copy as Override Into… — the source record's bytes, same FormKey, into a destination plugin (#436).")
        .WithDescription(
            "Serializes the source record's own text, verbatim, into the destination plugin's working " +
            "tree under the identical FormKey — no Mutagen deserialization, since a record's stored " +
            "document is already byte-identical to its source file. The destination's master dependency " +
            "on the record's origin is derived at compile from the bytes it now carries (ADR-0038); no " +
            "copy-specific master handling happens here.")
        .WithTags("Records")
        .Produces<RecordCopyAsOverrideResponse>()
        .ProducesProblem(400)
        .ProducesProblem(404)
        .ProducesProblem(409)
        .ProducesProblem(422)
        .ProducesProblem(500)
        .ProducesProblem(503);

        // #436 (ADR-0041 restoration): Copy as New Record Into… — a deep copy under a fresh FormKey,
        // via Mutagen's own record-level Duplicate. Same collision posture as CreateRecord, reused
        // rather than re-implemented.
        app.MapPost("/records/{formKey}/copy-as-new-record", (
            string formKey, RecordCopyAsNewRecordRequest request, RecordEditService edits) =>
            CopyRecordAsNewRecord(formKey, request, edits, logger))
        .WithName("CopyRecordAsNewRecord")
        .WithSummary("Copy as New Record Into… — a deep copy of the source record under a fresh FormKey (#436).")
        .WithDescription(
            "Deep-copies the source record (Mutagen's own record-level Duplicate — no mod object is " +
            "constructed) under a fresh FormKey in the destination plugin's working tree. FormKey is the " +
            "caller's requested one or the next free local FormID, both-refs collision-checked exactly " +
            "as CreateRecord's own allocation is. A FormLink from the record to itself is remapped onto " +
            "the new FormKey, so an internal self-reference follows the copy, not the original.")
        .WithTags("Records")
        .Produces<RecordCopyAsNewRecordResponse>()
        .ProducesProblem(400)
        .ProducesProblem(404)
        .ProducesProblem(409)
        .ProducesProblem(422)
        .ProducesProblem(500)
        .ProducesProblem(503);

        return app;
    }

    internal static IResult EditField(
        string formKey, RecordFieldEditRequest request, RecordEditService edits, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Received EditRecordField for {FormKey}.{FieldPath} in {Plugin} ({Origin})",
                decoded, request.FieldPath, request.Plugin, request.Origin);
        }

        if (string.IsNullOrWhiteSpace(request.Plugin) || string.IsNullOrWhiteSpace(request.Origin))
            return Results.Problem("Plugin name and origin are required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(request.FieldPath))
            return Results.Problem("A field path is required.", statusCode: 400);

        // The write path touches a file inside a live git working tree that Modbench does not own
        // exclusively (root CLAUDE.md) — it can be locked by another tool, replaced, or sitting on a
        // mount that just went away — and there is no global exception middleware to shape what
        // comes back. Every sibling write endpoint here catches and maps rather than letting one
        // escape as a bodyless 500 that a client cannot tell apart from the backend having died.
        // SourceFreshness already degrades on this same exception set on the read side, so this is
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
            logger.LogError(ex, "Could not write the source file while editing {FormKey}.{FieldPath}",
                decoded, request.FieldPath);
            return Results.Problem($"Could not write the source file for {decoded}: {ex.Message}", statusCode: 500);
        }
        catch (InvalidOperationException ex)
        {
            // 503, matching every sibling's own mapping for it: the session went away underneath the
            // request, which is a "not right now", never a bad request.
            logger.LogError(ex, "No usable session while editing {FormKey}.{FieldPath}", decoded, request.FieldPath);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }

    internal static IResult DeleteRecord(string formKey, RecordDeleteRequest request, RecordEditService edits, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received DeleteRecord for {FormKey} in {Plugin} ({Origin})", decoded, request.Plugin, request.Origin);
        }

        if (string.IsNullOrWhiteSpace(request.Plugin) || string.IsNullOrWhiteSpace(request.Origin))
            return Results.Problem("Plugin name and origin are required.", statusCode: 400);

        try
        {
            var result = edits.DeleteRecord(new PluginKey(request.Plugin, request.Origin), decoded);
            return result.Applied ? Results.Ok(new RecordDeleteResponse(true, decoded)) : Refusal(result);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not delete the source file for {FormKey}", decoded);
            return Results.Problem($"Could not delete the source file for {decoded}: {ex.Message}", statusCode: 500);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No usable session while deleting {FormKey}", decoded);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }

    internal static IResult RenumberRecord(string formKey, RecordRenumberRequest request, RecordEditService edits, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Received RenumberRecord for {FormKey} in {Plugin} ({Origin}) to {NewFormKey}",
                decoded, request.Plugin, request.Origin, request.NewFormKey ?? "(auto)");
        }

        if (string.IsNullOrWhiteSpace(request.Plugin) || string.IsNullOrWhiteSpace(request.Origin))
            return Results.Problem("Plugin name and origin are required.", statusCode: 400);

        try
        {
            var result = edits.RenumberRecord(new PluginKey(request.Plugin, request.Origin), decoded, request.NewFormKey);
            return result.Applied
                ? Results.Ok(new RecordRenumberResponse(true, decoded, result.NewFormKey!))
                : Refusal(result);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Q5(b): a partial-cascade failure lands here too, with the richer message
            // RecordEditService.RenumberRecord already built naming which repos have dirt.
            logger.LogError(ex, "Could not complete renumbering {FormKey}", decoded);
            return Results.Problem(ex.Message, statusCode: 500);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No usable session while renumbering {FormKey}", decoded);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }

    internal static IResult CopyRecordAsOverride(
        string formKey, RecordCopyAsOverrideRequest request, RecordEditService edits, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Received CopyRecordAsOverride for {FormKey} from {SourcePlugin} ({SourceOrigin}) into {DestinationPlugin} ({DestinationOrigin})",
                decoded, request.SourcePlugin, request.SourceOrigin, request.DestinationPlugin, request.DestinationOrigin);
        }

        if (string.IsNullOrWhiteSpace(request.SourcePlugin) || string.IsNullOrWhiteSpace(request.SourceOrigin))
            return Results.Problem("Source plugin name and origin are required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(request.DestinationPlugin) || string.IsNullOrWhiteSpace(request.DestinationOrigin))
            return Results.Problem("Destination plugin name and origin are required.", statusCode: 400);

        try
        {
            var result = edits.CopyRecordAsOverride(
                new PluginKey(request.SourcePlugin, request.SourceOrigin), decoded,
                new PluginKey(request.DestinationPlugin, request.DestinationOrigin));
            return result.Applied
                ? Results.Ok(new RecordCopyAsOverrideResponse(true, decoded))
                : Refusal(result);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not write the source file while copying {FormKey} as an override", decoded);
            return Results.Problem($"Could not write the source file for the copy: {ex.Message}", statusCode: 500);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No usable session while copying {FormKey} as an override", decoded);
            return Results.Problem(ex.Message, statusCode: 503);
        }
    }

    internal static IResult CopyRecordAsNewRecord(
        string formKey, RecordCopyAsNewRecordRequest request, RecordEditService edits, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Received CopyRecordAsNewRecord for {FormKey} from {SourcePlugin} ({SourceOrigin}) into {DestinationPlugin} ({DestinationOrigin})",
                decoded, request.SourcePlugin, request.SourceOrigin, request.DestinationPlugin, request.DestinationOrigin);
        }

        if (string.IsNullOrWhiteSpace(request.SourcePlugin) || string.IsNullOrWhiteSpace(request.SourceOrigin))
            return Results.Problem("Source plugin name and origin are required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(request.DestinationPlugin) || string.IsNullOrWhiteSpace(request.DestinationOrigin))
            return Results.Problem("Destination plugin name and origin are required.", statusCode: 400);

        try
        {
            var result = edits.CopyRecordAsNewRecord(
                new PluginKey(request.SourcePlugin, request.SourceOrigin), decoded,
                new PluginKey(request.DestinationPlugin, request.DestinationOrigin), request.RequestedFormKey);
            return result.Applied
                ? Results.Ok(new RecordCopyAsNewRecordResponse(true, decoded, result.NewFormKey!))
                : Refusal(result);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Could not write the source file while copying {FormKey} as a new record", decoded);
            return Results.Problem($"Could not write the source file for the copy: {ex.Message}", statusCode: 500);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "No usable session while copying {FormKey} as a new record", decoded);
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
    // Internal, not private: PluginEndpoints.CreateRecord (#427) shares this exact mapping — the
    // route lives under /plugins/{plugin}/records (the FormKey doesn't exist to key a /records/{formKey}
    // route on), but a refused create is the same RecordEditResult shape as every other write-path
    // refusal here, and a second copy of this switch is how the two would drift.
    internal static IResult Refusal(RecordEditResult result) => Results.Problem(
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
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received GetReferences for {FormKey}", formKey);
        }
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
