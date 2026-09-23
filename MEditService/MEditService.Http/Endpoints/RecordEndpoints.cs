using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries;

namespace MEditService.Http.Endpoints;

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

        // ADR-0007: the single write path's one door. Scripts and agents reach the same
        // handler the UI does, which is why the untracked refusal is expressible here.
        app.MapPost("/records/{formKey}/edit", (
            string formKey, RecordEditRequest request, EditRecordHandler edits) =>
            EditRecord(formKey, request, edits, logger))
        .WithName("EditRecord")
        .WithTags("Records")
        .Produces<RecordEditResponse>()
        .ProducesProblem(400)
        .ProducesProblem(404)
        .ProducesProblem(409)
        .ProducesProblem(422)
        // The source file is not ours exclusively — an I/O failure mid-edit is a real answer this
        // route can give, so it is declared like every other (endpoint invariant).
        .ProducesProblem(500)
        .ProducesProblem(503);

        // Delete-record — each record's source file goes away and the null-Body working-tree
        // mechanism takes it from there. Same refusals as EditRecord above, answered per record.
        app.MapPost("/records/delete", (RecordDeleteRequest request, DeleteRecordHandler edits) =>
            DeleteRecord(request, edits, logger))
        .WithName("DeleteRecord")
        .WithSummary("Delete records as working-tree changes, each on its own.")
        .WithDescription(
            "Deletes each record's source file — a git-native, null-Body working-tree change: " +
            "gone at Effective, still served at Head until the deletion is committed and " +
            "compiled. Each record is deleted or refused on its own, and the answer names both. No " +
            "reference cascade — a FormLink elsewhere pointing at a deleted record goes dangling and " +
            "surfaces as an ordinary compile diagnostic (ADR-0007), the same as any other dangling link.")
        .WithTags("Records")
        .Produces<RecordDeleteResponse>()
        .ProducesProblem(400);

        app.MapPost("/records/{formKey}/renumber", (
            string formKey, RecordRenumberRequest request, RenumberRecordHandler edits) =>
            RenumberRecord(formKey, request, edits, logger))
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
        // A rolled-back cascade surfaces here too — same shape as every other write path's I/O
        // failure, with a richer message naming what the rollback deliberately left standing (ADR-0007).
        .ProducesProblem(500)
        .ProducesProblem(503);

        // ADR-0007: the source record's own bytes land under the same FormKey in the destination.
        app.MapPost("/records/{formKey}/copy-as-override", (
            string formKey, RecordCopyAsOverrideRequest request, CopyRecordAsOverrideHandler edits) =>
            CopyRecordAsOverride(formKey, request, edits, logger))
        .WithName("CopyRecordAsOverride")
        .WithSummary("Copy as Override Into… — the source record's bytes, same FormKey, into a destination plugin.")
        .WithDescription(
            "Serializes the source record's own text, verbatim, into the destination plugin's working " +
            "tree under the identical FormKey — no Mutagen deserialization, since a record's stored " +
            "document is already byte-identical to its source file. The destination's master dependency " +
            "on the record's origin is derived at compile from the bytes it now carries (ADR-0008); no " +
            "copy-specific master handling happens here.")
        .WithTags("Records")
        .Produces<RecordCopyAsOverrideResponse>()
        .ProducesProblem(400)
        .ProducesProblem(404)
        .ProducesProblem(409)
        .ProducesProblem(422)
        .ProducesProblem(500)
        .ProducesProblem(503);

        // ADR-0007: Copy as New Record Into… — the source record itself under a fresh FormKey, via
        // Mutagen's own Duplicate. A top-level record's child slots are cleared; an embedded
        // child's whole subtree rides along under fresh FormKeys.
        app.MapPost("/records/{formKey}/copy-as-new-record", (
            string formKey, RecordCopyAsNewRecordRequest request, CopyRecordAsNewRecordHandler edits) =>
            CopyRecordAsNewRecord(formKey, request, edits, logger))
        .WithName("CopyRecordAsNewRecord")
        .WithSummary(
            "Copy as New Record Into… — the source record under a fresh FormKey; a top-level record's " +
            "child slots are cleared, an embedded child's whole subtree copies with it.")
        .WithDescription(
            "Copies the source record (Mutagen's own record-level Duplicate — no mod object is " +
            "constructed) under a fresh FormKey in the destination plugin's working tree. A top-level " +
            "record's own child slots are cleared, since a container's children never ride along that " +
            "way; an embedded child (a quest topic, a topic response) instead copies its whole embedded " +
            "subtree, each descendant under its own fresh FormKey, minting the container chain in the " +
            "destination when it is missing. FormKey is the caller's requested one or the next free " +
            "local FormID, both-refs collision-checked exactly as CreateRecord's own allocation is. A " +
            "FormLink from the record to itself is remapped onto the new FormKey, so an internal " +
            "self-reference follows the copy, not the original.")
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
    internal static IResult EditRecord(
        string formKey, RecordEditRequest request, EditRecordHandler edits, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        var spelled = RecordEditEnvelope.Spell(request.Path ?? []);
        return WriteEndpointMapping.Execute(
            logReceived: () =>
            {
                if (logger.IsEnabled(LogLevel.Information))
                {
                    logger.LogInformation(
                        "Received EditRecord {Op} {Path} for {FormKey} in {Plugin} ({Origin})",
                        request.Op, spelled, decoded, request.Plugin, request.Origin);
                }
            },
            validate: () =>
            {
                if (string.IsNullOrWhiteSpace(request.Plugin) || string.IsNullOrWhiteSpace(request.Origin))
                    return Results.Problem("Plugin name and origin are required.", statusCode: 400);
                if (string.IsNullOrWhiteSpace(request.Op) || request.Path is not { Count: > 0 })
                    return Results.Problem("An operation and a path are required.", statusCode: 400);
                return null;
            },
            execute: () => edits.Edit(
                new PluginCopyKey(request.Plugin, request.Origin), decoded,
                new RecordEditEnvelope(request.Op, request.Path ?? [], request.Value)),
            onApplied: result => Results.Ok(new RecordEditResponse(true, decoded, spelled)),
            onWriteFailure: ex =>
            {
                logger.LogError(ex, "Could not write the source file while editing {FormKey} at {Path}", decoded, spelled);
                return WriteEndpointMapping.WriteFailure($"Could not write the source file for {decoded}: {ex.Message}");
            },
            onMalformedFormKey: null,
            onNoLoadOrder: ex =>
            {
                // 503, matching every sibling's own mapping for it: the load order went away
                // underneath the request, which is a "not right now", never a bad request.
                logger.LogError(ex, "No usable loadOrder while editing {FormKey} at {Path}", decoded, spelled);
                return WriteEndpointMapping.NoLoadOrder(ex);
            });
    }

    internal static IResult DeleteRecord(RecordDeleteRequest request, DeleteRecordHandler edits, ILogger logger)
    {
        var records = request.Records ?? [];
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received DeleteRecord for {Count} records", records.Count);
        }
        if (records.Count == 0)
            return Results.Problem("At least one record is required.", statusCode: 400);
        if (records.Any(r =>
                string.IsNullOrWhiteSpace(r.FormKey) || string.IsNullOrWhiteSpace(r.Plugin) || string.IsNullOrWhiteSpace(r.Origin)))
            return Results.Problem("Every record needs a FormKey, a plugin name and an origin.", statusCode: 400);

        var result = edits.DeleteRecords(
            [.. records.Select(r => new RecordAt(new PluginCopyKey(r.Plugin, r.Origin), r.FormKey))]);
        return Results.Ok(new RecordDeleteResponse(
            [.. result.Applied.Select(Addressed)],
            [.. result.Refused.Select(r => new RecordAddressRefusal(Addressed(r.Record), r.Refusal, r.Message))]));
    }

    private static RecordAddress Addressed(RecordAt record) =>
        new(record.FormKey, record.Plugin.Name, record.Plugin.Origin);

    internal static IResult RenumberRecord(
        string formKey, RecordRenumberRequest request, RenumberRecordHandler edits, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        return WriteEndpointMapping.Execute(
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
            execute: () => edits.RenumberRecord(new PluginCopyKey(request.Plugin, request.Origin), decoded, request.NewFormKey),
            onApplied: result => Results.Ok(new RecordRenumberResponse(true, decoded, WriteEndpointMapping.RequireNewFormKey(result))),
            onWriteFailure: ex =>
            {
                // A rolled-back cascade lands here too, with the richer message
                // RenumberRecordHandler already built naming the paths it left standing (ADR-0007) —
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
        string formKey, RecordCopyAsOverrideRequest request, CopyRecordAsOverrideHandler edits, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        return WriteEndpointMapping.Execute(
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
                new PluginCopyKey(request.SourcePlugin, request.SourceOrigin), decoded,
                new PluginCopyKey(request.DestinationPlugin, request.DestinationOrigin)),
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
        string formKey, RecordCopyAsNewRecordRequest request, CopyRecordAsNewRecordHandler edits, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        return WriteEndpointMapping.Execute(
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
                new PluginCopyKey(request.SourcePlugin, request.SourceOrigin), decoded,
                new PluginCopyKey(request.DestinationPlugin, request.DestinationOrigin), request.RequestedFormKey),
            onApplied: result => Results.Ok(new RecordCopyAsNewRecordResponse(true, decoded, WriteEndpointMapping.RequireNewFormKey(result))),
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
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            logger.LogError(ex, "Failed to get references for {FormKey}", decoded);
            return Results.Problem(ex.Message);
        }
    }
}
