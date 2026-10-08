using System.Diagnostics;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Http.Endpoints;

internal static class RecordEndpoints
{
    public static IEndpointRouteBuilder MapRecordEndpoints(this IEndpointRouteBuilder app, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(RecordEndpoints));

        app.MapGet("/records", (
            IRecordQueryService svc,
            string? plugin,
            string[]? type,
            string? search,
            string? origin = null,
            int limit = 50,
            int offset = 0) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetRecords for {Plugin} ({Origin}) {Types} {Search}", plugin, origin, type, search);
            }
            PluginAddress? address = null;
            if (!string.IsNullOrWhiteSpace(plugin) && !string.IsNullOrWhiteSpace(origin))
                address = new PluginAddress(plugin, origin);
            else if (!string.IsNullOrWhiteSpace(plugin) || !string.IsNullOrWhiteSpace(origin))
                return Results.Problem("Name a plugin with both plugin and origin, or neither to browse every plugin.", statusCode: 400);
            var result = svc.GetRecords(type is { Length: > 0 } ? type : null, address, search, limit, offset);
            return Results.Ok(result);
        })
        .WithName("GetRecords")
        .WithTags("Records")
        .Produces<PagedResult<RecordSummary>>()
        .ProducesProblem(400)
        .ProducesProblem(503);

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
        .ProducesProblem(404)
        .ProducesProblem(503);

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
        .ProducesProblem(404)
        .ProducesProblem(503);

        app.MapPost("/records/{formKey}/compare", (string formKey, CopyText copy, IRecordQueryService svc) =>
            CompareRecord(Uri.UnescapeDataString(formKey), copy, svc))
        .WithName("CompareRecordWithText")
        .WithSummary("One record as every active plugin has it, one plugin's copy read from the document text given.")
        .WithDescription(
            "The named plugin's column, and the conflict states, are read from the text whether or not that plugin " +
            "is active. The text is the document carrying the record: its own, or an embedded child's container's. " +
            "Text that is no record document, or does not carry the record, is a column that could not be parsed. " +
            "Nothing is stored.")
        .WithTags("Records")
        .Produces<CompareResult>()
        .ProducesProblem(400)
        .ProducesProblem(404)
        .ProducesProblem(503);

        app.MapPost("/records/compare", (CompareRecordsRequest request, IRecordQueryService svc) =>
            CompareRecords(request.Copies ?? [], svc))
        .WithName("CompareRecords")
        .WithSummary("Several records side by side: one column per copy, in the order given, with no conflict state.")
        .WithDescription(
            "A copy's DocumentText, when given, is the document carrying that column's record, read whether or not " +
            "its plugin is active; the copy is otherwise the one its plugin holds.")
        .WithTags("Records")
        .Produces<CompareRecordsResponse>()
        .ProducesProblem(400)
        .ProducesProblem(503);

        app.MapGet("/plugin-source/record", (string? path, IRecordQueryService svc) =>
        {
            if (path is null || !Path.IsPathFullyQualified(path))
                return Results.Problem("Name the file by its absolute path.", statusCode: 400);
            return svc.GetRecordOfFile(path) switch
            {
                RecordOfFileAnswer.Holds holds => Results.Ok(Addressed(holds.Record)),
                RecordOfFileAnswer.HoldsNone => Results.NoContent(),
                RecordOfFileAnswer.Refused refused => Results.Problem(refused.Why, statusCode: 422),
                _ => throw new UnreachableException(),
            };
        })
        .WithName("GetRecordOfFile")
        .WithDescription(
            "The record whose own document the file at an absolute path is, read from the file's text: its plugin and " +
            "FormKey. No content when the file holds no record. A file that cannot be read as a " +
            "record's own document refuses, saying why.")
        .WithTags("Records")
        .Produces<RecordAddress>()
        .Produces(204)
        .ProducesProblem(400)
        .ProducesProblem(422)
        .ProducesProblem(503);

        app.MapGet("/records/{formKey}/references", (string formKey, IRecordQueryService svc) =>
            GetReferences(nameof(IRecordQueryService.GetReferences), formKey, svc.GetReferences, logger))
        .WithName("GetReferences")
        .WithTags("Records")
        .Produces<IReadOnlyList<ReferenceResult>>()
        .ProducesProblem(503)
        .ProducesProblem(500);

        app.MapGet("/records/{formKey}/references-in-active-or-tracked-plugins", (string formKey, IRecordQueryService svc) =>
            GetReferences(
                nameof(IRecordQueryService.GetReferencesInActiveOrTrackedPlugins), formKey, svc.GetReferencesInActiveOrTrackedPlugins, logger))
        .WithName("GetReferencesInActiveOrTrackedPlugins")
        .WithTags("Records")
        .Produces<IReadOnlyList<ReferenceResult>>()
        .ProducesProblem(503)
        .ProducesProblem(500);

        // ADR-0001: the document is the caller's to change and save.
        app.MapPost("/records/{formKey}/edit-changes", (
            string formKey, RecordEditChangesRequest request, EditRecordChangesHandler edits) =>
            EditRecordChanges(formKey, request, edits, logger))
        .WithName("EditRecordChanges")
        .WithSummary("The changes an edit of a record makes to plugin source, writing nothing.")
        .WithDescription(
            "Given the edit and the current text of the document carrying the record, the text each document the edit " +
            "changes or creates holds afterwards, and each file or folder it moves. Moves come first and apply in order, each " +
            "against the tree the one before it left, and each document's " +
            "path is where it stands once moved. Every path is absolute. Any other document the edit reads is read from " +
            "disk. A refusal is the one the edit itself gives.")
        .WithTags("Records")
        .Produces<RecordEditChangesResponse>()
        .ProducesProblem(400)
        .ProducesProblem(404)
        .ProducesProblem(409)
        .ProducesProblem(422)
        .ProducesProblem(500);

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
        .ProducesProblem(400)
        .ProducesProblem(500)
        .ProducesProblem(503);

        // Copy (plugins.md, Copy) writes each destination's working tree (ADR-0007).
        app.MapPost("/records/copy", (RecordCopyRequest request, CopyRecordHandler edits) =>
            CopyRecord(request, edits, logger))
        .WithName("CopyRecord")
        .WithSummary("Copy records into destination plugins, each record into each destination on its own.")
        .WithDescription(
            "Override: the source record's own text lands verbatim in the destination under the same " +
            "FormKey, without its child records; the master dependency is derived at compile (ADR-0008). " +
            "New: a duplicate without its child records under the destination's next free FormID, with an EditorID derived from the source's, " +
            "and a self-reference follows the copy. A cell or a worldspace is refused as New. In every " +
            "mode, a container the destination lacks is copied in as an override. Replace applies to Override only. " +
            "Under Override, a destination that already holds the record is refused unless replace is given, and " +
            "a replacement changes the record's own fields only, keeping the children the destination's " +
            "copy carries. Each record and destination is applied or refused on its own, and the " +
            "answer names both.")
        .WithTags("Records")
        .Produces<RecordCopyResponse>()
        .ProducesProblem(400)
        .ProducesProblem(500)
        .ProducesProblem(503);

        app.MapPost("/records/with-children", (RecordsWithChildrenRequest request, ChildRecordQueryService svc) =>
            OverRecords(request.Records ?? [], validateOptions: () => null, answer: addressed =>
                Task.FromResult(Results.Ok(
                    svc.WithChildRecords(addressed).Select(Addressed)))))
        .WithName("GetRecordsWithChildren")
        .WithSummary("Which of the records have child records in their own plugin.")
        .WithTags("Records")
        .Produces<IReadOnlyList<RecordAddress>>()
        .ProducesProblem(400)
        .ProducesProblem(503);

        app.MapPost("/records/children-in-destinations", (ChildrenInDestinationsRequest request, ChildRecordQueryService svc) =>
        {
            var destinations = request.Destinations ?? [];
            return OverRecords(request.Records ?? [], validateOptions: () =>
                    destinations.Any(d => string.IsNullOrWhiteSpace(d.Name) || string.IsNullOrWhiteSpace(d.Origin))
                        ? Results.Problem("Every destination needs a name and an origin.", statusCode: 400)
                        : null,
                answer: addressed => Task.FromResult(Results.Ok(
                    svc.DestinationsHoldingChildRecords(addressed, destinations)
                        .Select(h => new RecordChildHolders(Addressed(h.Record), h.Destinations)))));
        })
        .WithName("GetChildrenInDestinations")
        .WithSummary("For each record, the destination plugins that hold any of its child records, at any depth.")
        .WithTags("Records")
        .Produces<IReadOnlyList<RecordChildHolders>>()
        .ProducesProblem(400)
        .ProducesProblem(503);

        return app;
    }

    internal static IResult EditRecordChanges(
        string formKey, RecordEditChangesRequest request, EditRecordChangesHandler edits, ILogger logger)
    {
        var decoded = Uri.UnescapeDataString(formKey);
        // A body missing its edit binds it as null, whatever the type says; validation answers that.
        RecordEditRequest? edit = request.Edit;
        var spelled = RecordEditEnvelope.Spell(edit?.Path ?? []);
        return WriteEndpointMapping.Execute(
            "EditChanges", logger,
            logReceived: () =>
            {
                if (logger.IsEnabled(LogLevel.Information))
                {
                    logger.LogInformation(
                        "Received EditRecordChanges {Op} {Path} for {FormKey} in {Plugin} ({Origin})",
                        edit?.Op, spelled, decoded, edit?.Plugin, edit?.Origin);
                }
            },
            validate: () => request.Text is null
                ? Results.Problem("The text of the document carrying the record is required.", statusCode: 400)
                : EditRequestProblem(edit),
            execute: () => edits.Changes(
                new PluginAddress(request.Edit.Plugin, request.Edit.Origin), decoded,
                new RecordEditEnvelope(request.Edit.Op, request.Edit.Path ?? [], request.Edit.Value), request.Text),
            outcome: answer => answer.Outcome,
            onApplied: answer => Results.Ok(new RecordEditChangesResponse(
                decoded, spelled, answer.Changes.Moves, answer.Changes.Documents, answer.Outcome.NewFormKey)));
    }

    private static IResult? EditRequestProblem(RecordEditRequest? request)
    {
        if (string.IsNullOrWhiteSpace(request?.Plugin) || string.IsNullOrWhiteSpace(request.Origin))
            return Results.Problem("Plugin name and origin are required.", statusCode: 400);
        if (string.IsNullOrWhiteSpace(request.Op) || request.Path is not { Count: > 0 })
            return Results.Problem("An operation and a path are required.", statusCode: 400);
        return null;
    }


    internal static Task<IResult> DeleteRecord(RecordDeleteRequest request, DeleteRecordHandler edits, ILogger logger)
    {
        var records = request.Records ?? [];
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received DeleteRecord for {Count} records", records.Count);
        }
        return OverRecords(records, validateOptions: () => null, answer: addressed =>
        {
            return WriteEndpointMapping.Answered(
                "Delete", logger,
                edits.DeleteRecords(addressed),
                WriteEndpointMapping.Refusal,
                landed => Addressed(landed.Item),
                refused => new RecordAddressRefusal(Addressed(refused.Item), refused.Refusal, refused.Message),
                (applied, refused) => new RecordDeleteResponse(applied, refused));
        });
    }

    internal static Task<IResult> CopyRecord(RecordCopyRequest request, CopyRecordHandler edits, ILogger logger)
    {
        var records = request.Records ?? [];
        var destinations = request.Destinations ?? [];
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Received CopyRecord {Mode} for {Count} records into {DestinationCount} destinations (replace: {Replace})",
                request.Mode, records.Count, destinations.Count, request.Replace);
        }
        return OverRecords(records, validateOptions: () =>
        {
            if (destinations.Count == 0)
                return Results.Problem("At least one destination is required.", statusCode: 400);
            if (destinations.Any(d => string.IsNullOrWhiteSpace(d.Name) || string.IsNullOrWhiteSpace(d.Origin)))
                return Results.Problem("Every destination needs a name and an origin.", statusCode: 400);
            return null;
        }, answer: addressed =>
        {
            return WriteEndpointMapping.Answered(
                "Copy", logger,
                edits.Copy(addressed, request.Mode, destinations, request.Replace),
                WriteEndpointMapping.Refusal,
                landed => new RecordCopyLanded(Addressed(landed.Item.Record), landed.Item.Destination, landed.Outcome),
                refused => new RecordCopyRefusal(
                    new RecordCopyItem(Addressed(refused.Item.Record), refused.Item.Destination), refused.Refusal, refused.Message),
                (applied, refused) => new RecordCopyResponse(applied, refused));
        });
    }

    // The routes over a selection of records share their request's shape.
    private static async Task<IResult> OverRecords(
        IReadOnlyList<RecordAddress> records,
        Func<IResult?> validateOptions, Func<IReadOnlyList<RecordAt>, Task<IResult>> answer)
    {
        if (records.Count == 0)
            return Results.Problem("At least one record is required.", statusCode: 400);
        if (records.Any(r =>
                string.IsNullOrWhiteSpace(r.FormKey) || string.IsNullOrWhiteSpace(r.Plugin) || string.IsNullOrWhiteSpace(r.Origin)))
            return Results.Problem("Every record needs a FormKey, a plugin name and an origin.", statusCode: 400);
        if (validateOptions() is { } invalid) return invalid;

        return await answer([.. records.Select(r => new RecordAt(new PluginAddress(r.Plugin, r.Origin), r.FormKey))]);
    }

    private static RecordAddress Addressed(RecordAt record) =>
        new(record.FormKey, record.Plugin.Name, record.Plugin.Origin);

    private static CopyMissing Wire(MissingCopy missing) =>
        new(missing.Copy.FormKey, missing.Copy.Plugin, missing.Reason, missing.Message);

    internal static IResult CompareRecords(IReadOnlyList<RecordCopy> copies, IRecordQueryService svc)
    {
        if (copies.Count == 0)
            return Results.Problem("At least one record is required.", statusCode: 400);
        if (copies.Any(c => string.IsNullOrWhiteSpace(c.FormKey)
                || string.IsNullOrWhiteSpace(c.Plugin.Name) || string.IsNullOrWhiteSpace(c.Plugin.Origin)))
            return Results.Problem("Every record needs a FormKey, a plugin name and an origin.", statusCode: 400);
        try
        {
            return Results.Ok(new CompareRecordsResponse(svc.GetCompareRecords(copies), []));
        }
        catch (RecordCopiesMissingException refusal)
        {
            return Results.Ok(new CompareRecordsResponse(null, [.. refusal.Missing.Select(Wire)]));
        }
    }

    internal static IResult CompareRecord(string formKey, CopyText copy, IRecordQueryService svc)
    {
        if (copy.DocumentText is null || string.IsNullOrWhiteSpace(copy.Plugin.Name) || string.IsNullOrWhiteSpace(copy.Plugin.Origin))
            return Results.Problem("A plugin name, an origin and a document text are required.", statusCode: 400);
        return svc.GetCompare(formKey, copy) is { } result
            ? Results.Ok(result)
            : Results.Problem("No plugin indexes this record.", statusCode: 404);
    }

    internal static IResult GetReferences(
        string operation, string formKey, Func<string, IReadOnlyList<ReferenceResult>> read, ILogger logger)
    {
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation("Received {Operation} for {FormKey}", operation, formKey);
        }
        return Results.Ok(read(Uri.UnescapeDataString(formKey)));
    }
}
