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

        // ADR-0041: the single write path's one door. Scripts and agents (ADR-0024) reach the same
        // RecordEditService the UI does, which is why the untracked refusal is expressible here.
        app.MapPost("/records/{formKey}/field", (
            string formKey, RecordFieldEditRequest request, RecordEditService edits, IndexWriteGate gate) =>
            EditField(formKey, request, edits, gate, logger))
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

        // Delete-record — the source file goes away and the null-Body working-tree mechanism takes
        // it from there. Same door, same refusals, same doctrine as EditField above.
        app.MapPost("/records/{formKey}/delete", (
            string formKey, RecordDeleteRequest request, RecordEditService edits, IndexWriteGate gate) =>
            DeleteRecord(formKey, request, edits, gate, logger))
        .WithName("DeleteRecord")
        .WithSummary("Delete a record as a working-tree change.")
        .WithDescription(
            "Deletes the record's source file — a git-native, null-Body working-tree change: " +
            "gone at Effective, still served at Head until the deletion is committed and " +
            "compiled. No reference cascade — a FormLink elsewhere pointing at the deleted record goes " +
            "dangling and surfaces as an ordinary compile diagnostic (ADR-0041), the same as any other " +
            "dangling link.")
        .WithTags("Records")
        .Produces<RecordDeleteResponse>()
        .ProducesProblem(400)
        .ProducesProblem(404)
        .ProducesProblem(409)
        .ProducesProblem(422)
        .ProducesProblem(500)
        .ProducesProblem(503);

        // Renumber — a delete+create pair plus the cross-plugin reference cascade.
        app.MapPost("/records/{formKey}/renumber", (
            string formKey, RecordRenumberRequest request, RecordEditService edits, IndexWriteGate gate) =>
            RenumberRecord(formKey, request, edits, gate, logger))
        .WithName("RenumberRecord")
        .WithSummary("Renumber a native record's FormKey as a delete+create pair.")
        .WithDescription(
            "Native records only. Rewrites the record under a new FormKey (auto-allocated, both-refs " +
            "collision-safe, or an explicit target) as a working-tree delete of the old source file " +
            "plus a create of the new one, cascading the FormKey change into every tracked plugin that " +
            "references it.")
        .WithTags("Records")
        .Produces<RecordRenumberResponse>()
        .ProducesProblem(400)
        .ProducesProblem(404)
        .ProducesProblem(409)
        .ProducesProblem(422)
        // A partial-cascade failure surfaces here too — same shape as every other write
        // path's I/O failure, just with a richer message naming which repos already have dirt.
        .ProducesProblem(500)
        .ProducesProblem(503);

        // ADR-0041: Copy as Override Into… — the source record's own bytes,
        // landing under the same FormKey in the destination's working tree.
        app.MapPost("/records/{formKey}/copy-as-override", (
            string formKey, RecordCopyAsOverrideRequest request, RecordEditService edits, IndexWriteGate gate) =>
            CopyRecordAsOverride(formKey, request, edits, gate, logger))
        .WithName("CopyRecordAsOverride")
        .WithSummary("Copy as Override Into… — the source record's bytes, same FormKey, into a destination plugin.")
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

        // ADR-0041: Copy as New Record Into… — a deep copy under a fresh FormKey,
        // via Mutagen's own record-level Duplicate. Same collision posture as CreateRecord, reused
        // rather than re-implemented.
        app.MapPost("/records/{formKey}/copy-as-new-record", (
            string formKey, RecordCopyAsNewRecordRequest request, RecordEditService edits, IndexWriteGate gate) =>
            CopyRecordAsNewRecord(formKey, request, edits, gate, logger))
        .WithName("CopyRecordAsNewRecord")
        .WithSummary("Copy as New Record Into… — a deep copy of the source record under a fresh FormKey.")
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

    // The source file sits in a working tree Modbench does not own exclusively (root CLAUDE.md)
    // and there is no exception middleware, so I/O failures are mapped here rather than escaping
    // as a bodyless 500.
    internal static IResult EditField(
        string formKey, RecordFieldEditRequest request, RecordEditService edits, IndexWriteGate gate, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        return WriteEndpointMapping.Execute(
            gate,
            logReceived: () =>
            {
                if (logger.IsEnabled(LogLevel.Information))
                {
                    logger.LogInformation(
                        "Received EditRecordField for {FormKey}.{FieldPath} in {Plugin} ({Origin})",
                        decoded, request.FieldPath, request.Plugin, request.Origin);
                }
            },
            validate: () =>
            {
                if (string.IsNullOrWhiteSpace(request.Plugin) || string.IsNullOrWhiteSpace(request.Origin))
                    return Results.Problem("Plugin name and origin are required.", statusCode: 400);
                if (string.IsNullOrWhiteSpace(request.FieldPath))
                    return Results.Problem("A field path is required.", statusCode: 400);
                return null;
            },
            execute: () => edits.EditField(
                new PluginKey(request.Plugin, request.Origin), decoded, request.FieldPath, request.Value),
            onApplied: result => Results.Ok(new RecordFieldEditResponse(true, decoded, request.FieldPath)),
            onWriteFailure: ex =>
            {
                logger.LogError(ex, "Could not write the source file while editing {FormKey}.{FieldPath}",
                    decoded, request.FieldPath);
                return WriteEndpointMapping.WriteFailure($"Could not write the source file for {decoded}: {ex.Message}");
            },
            onMalformedFormKey: null,
            onNoLoadOrder: ex =>
            {
                // 503, matching every sibling's own mapping for it: the load order went away
                // underneath the request, which is a "not right now", never a bad request.
                logger.LogError(ex, "No usable loadOrder while editing {FormKey}.{FieldPath}", decoded, request.FieldPath);
                return WriteEndpointMapping.NoLoadOrder(ex);
            });
    }

    internal static IResult DeleteRecord(
        string formKey, RecordDeleteRequest request, RecordEditService edits, IndexWriteGate gate, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        return WriteEndpointMapping.Execute(
            gate,
            logReceived: () =>
            {
                if (logger.IsEnabled(LogLevel.Information))
                {
                    logger.LogInformation("Received DeleteRecord for {FormKey} in {Plugin} ({Origin})", decoded, request.Plugin, request.Origin);
                }
            },
            validate: () =>
                string.IsNullOrWhiteSpace(request.Plugin) || string.IsNullOrWhiteSpace(request.Origin)
                    ? Results.Problem("Plugin name and origin are required.", statusCode: 400)
                    : null,
            execute: () => edits.DeleteRecord(new PluginKey(request.Plugin, request.Origin), decoded),
            onApplied: result => Results.Ok(new RecordDeleteResponse(true, decoded)),
            onWriteFailure: ex =>
            {
                logger.LogError(ex, "Could not delete the source file for {FormKey}", decoded);
                return WriteEndpointMapping.WriteFailure($"Could not delete the source file for {decoded}: {ex.Message}");
            },
            onMalformedFormKey: null,
            onNoLoadOrder: ex =>
            {
                logger.LogError(ex, "No usable loadOrder while deleting {FormKey}", decoded);
                return WriteEndpointMapping.NoLoadOrder(ex);
            });
    }

    internal static IResult RenumberRecord(
        string formKey, RecordRenumberRequest request, RecordEditService edits, IndexWriteGate gate, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        return WriteEndpointMapping.Execute(
            gate,
            logReceived: () =>
            {
                if (logger.IsEnabled(LogLevel.Information))
                {
                    logger.LogInformation(
                        "Received RenumberRecord for {FormKey} in {Plugin} ({Origin}) to {NewFormKey}",
                        decoded, request.Plugin, request.Origin, request.NewFormKey ?? "(auto)");
                }
            },
            validate: () =>
                string.IsNullOrWhiteSpace(request.Plugin) || string.IsNullOrWhiteSpace(request.Origin)
                    ? Results.Problem("Plugin name and origin are required.", statusCode: 400)
                    : null,
            execute: () => edits.RenumberRecord(new PluginKey(request.Plugin, request.Origin), decoded, request.NewFormKey),
            onApplied: result => Results.Ok(new RecordRenumberResponse(true, decoded, result.NewFormKey!)),
            onWriteFailure: ex =>
            {
                // A partial-cascade failure lands here too, with the richer message
                // RecordEditService.RenumberRecord already built naming which repos have dirt —
                // ex.Message goes straight through, unwrapped, unlike every sibling's own
                // onWriteFailure here.
                logger.LogError(ex, "Could not complete renumbering {FormKey}", decoded);
                return WriteEndpointMapping.WriteFailure(ex.Message);
            },
            // request.NewFormKey reaches Mutagen's FormKey.Factory with no TryFactory guard, so a
            // malformed value throws ArgumentException: malformed syntax is a 400, never Refusal's 422.
            onMalformedFormKey: ex =>
            {
                logger.LogError(ex, "Malformed FormKey renumbering {FormKey}", decoded);
                return WriteEndpointMapping.MalformedFormKey(ex);
            },
            onNoLoadOrder: ex =>
            {
                logger.LogError(ex, "No usable loadOrder while renumbering {FormKey}", decoded);
                return WriteEndpointMapping.NoLoadOrder(ex);
            });
    }

    internal static IResult CopyRecordAsOverride(
        string formKey, RecordCopyAsOverrideRequest request, RecordEditService edits, IndexWriteGate gate,
        ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        return WriteEndpointMapping.Execute(
            gate,
            logReceived: () =>
            {
                if (logger.IsEnabled(LogLevel.Information))
                {
                    logger.LogInformation(
                        "Received CopyRecordAsOverride for {FormKey} from {SourcePlugin} ({SourceOrigin}) into {DestinationPlugin} ({DestinationOrigin})",
                        decoded, request.SourcePlugin, request.SourceOrigin, request.DestinationPlugin, request.DestinationOrigin);
                }
            },
            validate: () =>
            {
                if (string.IsNullOrWhiteSpace(request.SourcePlugin) || string.IsNullOrWhiteSpace(request.SourceOrigin))
                    return Results.Problem("Source plugin name and origin are required.", statusCode: 400);
                if (string.IsNullOrWhiteSpace(request.DestinationPlugin) || string.IsNullOrWhiteSpace(request.DestinationOrigin))
                    return Results.Problem("Destination plugin name and origin are required.", statusCode: 400);
                return null;
            },
            execute: () => edits.CopyRecordAsOverride(
                new PluginKey(request.SourcePlugin, request.SourceOrigin), decoded,
                new PluginKey(request.DestinationPlugin, request.DestinationOrigin)),
            onApplied: result => Results.Ok(new RecordCopyAsOverrideResponse(true, decoded)),
            onWriteFailure: ex =>
            {
                logger.LogError(ex, "Could not write the source file while copying {FormKey} as an override", decoded);
                return WriteEndpointMapping.WriteFailure($"Could not write the source file for the copy: {ex.Message}");
            },
            onMalformedFormKey: null,
            onNoLoadOrder: ex =>
            {
                logger.LogError(ex, "No usable loadOrder while copying {FormKey} as an override", decoded);
                return WriteEndpointMapping.NoLoadOrder(ex);
            });
    }

    internal static IResult CopyRecordAsNewRecord(
        string formKey, RecordCopyAsNewRecordRequest request, RecordEditService edits, IndexWriteGate gate,
        ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        return WriteEndpointMapping.Execute(
            gate,
            logReceived: () =>
            {
                if (logger.IsEnabled(LogLevel.Information))
                {
                    logger.LogInformation(
                        "Received CopyRecordAsNewRecord for {FormKey} from {SourcePlugin} ({SourceOrigin}) into {DestinationPlugin} ({DestinationOrigin})",
                        decoded, request.SourcePlugin, request.SourceOrigin, request.DestinationPlugin, request.DestinationOrigin);
                }
            },
            validate: () =>
            {
                if (string.IsNullOrWhiteSpace(request.SourcePlugin) || string.IsNullOrWhiteSpace(request.SourceOrigin))
                    return Results.Problem("Source plugin name and origin are required.", statusCode: 400);
                if (string.IsNullOrWhiteSpace(request.DestinationPlugin) || string.IsNullOrWhiteSpace(request.DestinationOrigin))
                    return Results.Problem("Destination plugin name and origin are required.", statusCode: 400);
                return null;
            },
            execute: () => edits.CopyRecordAsNewRecord(
                new PluginKey(request.SourcePlugin, request.SourceOrigin), decoded,
                new PluginKey(request.DestinationPlugin, request.DestinationOrigin), request.RequestedFormKey),
            onApplied: result => Results.Ok(new RecordCopyAsNewRecordResponse(true, decoded, result.NewFormKey!)),
            onWriteFailure: ex =>
            {
                logger.LogError(ex, "Could not write the source file while copying {FormKey} as a new record", decoded);
                return WriteEndpointMapping.WriteFailure($"Could not write the source file for the copy: {ex.Message}");
            },
            // request.RequestedFormKey reaches Mutagen's FormKey.Factory with no TryFactory guard, so
            // a malformed value throws ArgumentException: malformed syntax is a 400, never Refusal's 422.
            onMalformedFormKey: ex =>
            {
                logger.LogError(ex, "Malformed FormKey copying {FormKey} as a new record", decoded);
                return WriteEndpointMapping.MalformedFormKey(ex);
            },
            onNoLoadOrder: ex =>
            {
                logger.LogError(ex, "No usable loadOrder while copying {FormKey} as a new record", decoded);
                return WriteEndpointMapping.NoLoadOrder(ex);
            });
    }

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
