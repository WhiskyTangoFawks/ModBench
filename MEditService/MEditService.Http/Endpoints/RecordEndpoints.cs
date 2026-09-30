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
            int offset = 0,
            bool unfiltered = false) =>
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.LogInformation("Received GetRecords for {Plugin} ({Origin}) {Type} {Search}", plugin, origin, type, search);
            }
            // ADR-0012 invariant 1: a plugin is (origin, filename) together, so half an identity names nothing.
            if (string.IsNullOrEmpty(plugin) != string.IsNullOrEmpty(origin))
                return Results.Problem("Name a plugin with both plugin and origin, or neither to browse every plugin.", statusCode: 400);
            var result = svc.GetRecords(type, plugin, search, limit, offset, origin, unfiltered);
            return Results.Ok(result);
        })
        .WithName("GetRecords")
        .WithTags("Records")
        .Produces<PagedResult<RecordSummary>>()
        .ProducesProblem(400);

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

        // ADR-0007: each record lands in each destination's working tree, as an override under its own
        // FormKey or as a duplicate under the destination's next free one.
        app.MapPost("/records/copy", (RecordCopyRequest request, CopyRecordHandler edits) =>
            CopyRecord(request, edits, logger))
        .WithName("CopyRecord")
        .WithSummary("Copy records into destination plugins, each record into each destination on its own.")
        .WithDescription(
            "Override: the source record's own text lands verbatim in the destination under the same " +
            "FormKey; the master dependency is derived at compile (ADR-0008). A destination that already " +
            "holds the record is refused unless replace is given, and a replacement changes its own fields " +
            "only, keeping the children the destination's copy carries. New: a duplicate under the " +
            "destination's next free FormID, with an EditorID derived from the source's; a container's " +
            "embedded children copy under fresh FormKeys, and a self-reference follows the copy. Each " +
            "record and destination is applied or refused on its own, and the answer names both.")
        .WithTags("Records")
        .Produces<RecordCopyResponse>()
        .ProducesProblem(400)
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
                new PluginAddress(request.Plugin, request.Origin), decoded,
                new RecordEditEnvelope(request.Op, request.Path ?? [], request.Value)),
            onApplied: result => Results.Ok(new RecordEditResponse(true, decoded, spelled, result.NewFormKey)),
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
        return OverRecords(records, "deleting", logger, validateOptions: () => null, answer: addressed =>
        {
            var result = edits.DeleteRecords(addressed);
            if (result.SelectionRefusal is { } selectionRefusal) return WriteEndpointMapping.Refusal(selectionRefusal);
            return Results.Ok(new RecordDeleteResponse(
                [.. result.Applied.Select(Addressed)],
                [.. result.Refused.Select(r => new RecordAddressRefusal(Addressed(r.Record), r.Refusal, r.Message))]));
        });
    }

    internal static IResult CopyRecord(RecordCopyRequest request, CopyRecordHandler edits, ILogger logger)
    {
        var records = request.Records ?? [];
        var destinations = request.Destinations ?? [];
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Received CopyRecord {Mode} for {Count} records into {DestinationCount} destinations (replace: {Replace})",
                request.Mode, records.Count, destinations.Count, request.Replace);
        }
        return OverRecords(records, "copying", logger, validateOptions: () =>
        {
            if (destinations.Count == 0)
                return Results.Problem("At least one destination is required.", statusCode: 400);
            if (destinations.Any(d => string.IsNullOrWhiteSpace(d.Name) || string.IsNullOrWhiteSpace(d.Origin)))
                return Results.Problem("Every destination needs a name and an origin.", statusCode: 400);
            if (request.Replace && request.Mode != CopyMode.Override)
                return Results.Problem("The replace Option applies to a copy as override only.", statusCode: 400);
            return null;
        }, answer: addressed =>
        {
            var result = edits.Copy(addressed, request.Mode, destinations, request.Replace);
            return Results.Ok(new RecordCopyResponse(
                [.. result.Applied.Select(l => new RecordCopyLanded(Addressed(l.Item.Record), l.Item.Destination, l.NewFormKey))],
                [.. result.Refused.Select(r => new RecordCopyRefusal(
                    Addressed(r.Item.Record), r.Item.Destination, r.Refusal, r.Message))]));
        });
    }

    // The routes over a selection of records share their request's shape and one answer that is no
    // record's: the load order went away underneath the request, a "not right now".
    private static IResult OverRecords(
        IReadOnlyList<RecordAddress> records, string gesture, ILogger logger,
        Func<IResult?> validateOptions, Func<IReadOnlyList<RecordAt>, IResult> answer)
    {
        if (records.Count == 0)
            return Results.Problem("At least one record is required.", statusCode: 400);
        if (records.Any(r =>
                string.IsNullOrWhiteSpace(r.FormKey) || string.IsNullOrWhiteSpace(r.Plugin) || string.IsNullOrWhiteSpace(r.Origin)))
            return Results.Problem("Every record needs a FormKey, a plugin name and an origin.", statusCode: 400);
        if (validateOptions() is { } invalid) return invalid;

        try
        {
            return answer([.. records.Select(r => new RecordAt(new PluginAddress(r.Plugin, r.Origin), r.FormKey))]);
        }
        catch (NoLoadOrderException ex)
        {
            logger.LogError(ex, "No usable loadOrder while {Gesture} {Count} records", gesture, records.Count);
            return WriteEndpointMapping.NoLoadOrder(ex);
        }
    }

    private static RecordAddress Addressed(RecordAt record) =>
        new(record.FormKey, record.Plugin.Name, record.Plugin.Origin);

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
