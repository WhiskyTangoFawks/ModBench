using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Session;
using Microsoft.AspNetCore.Mvc;

namespace MEditService.Api.Endpoints;

public static class ChangeEndpoints
{
    private const string Tag = "Changes";
    private const string NoSessionMessage = "No session loaded.";

    public static IEndpointRouteBuilder MapChangeEndpoints(this IEndpointRouteBuilder app)
    {
        MapRecordOperationEndpoints(app);
        MapChangeManagementEndpoints(app);
        return app;
    }

    // Record-lifecycle operations: edit, copy, delete, renumber, create.
    private static void MapRecordOperationEndpoints(IEndpointRouteBuilder app)
    {
        app.MapMethods("/records/{formKey}", ["PATCH"], PatchRecord)
            .WithName("PatchRecord")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PendingChange>>()
            // #147: one 422 envelope covers every rejection reason (reference/append-only/type-
            // mismatch/null-not-allowed alongside read-only-fields/ESL-ineligible) — see
            // PatchRecordValidationError for why (a bare array and ProblemDetails on the same status
            // code isn't representable in OpenAPI without oneOf machinery this repo doesn't have).
            .Produces<PatchRecordValidationError>(422)
            .ProducesProblem(404)
            .ProducesProblem(409);

        app.MapPost("/records/{formKey}/copy-to/{targetPlugin}", CopyRecordTo)
            .WithName("CopyRecordTo")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PendingChange>>()
            // #147: shares StageEditResult.ToHttpResult with PatchRecord — same single 422 envelope.
            .Produces<PatchRecordValidationError>(422)
            .ProducesProblem(404)
            .ProducesProblem(409);

        app.MapPost("/records/delete", DeleteRecords)
            .WithName("DeleteRecords")
            .WithTags(Tag)
            // #143: one 200 envelope covers all three outcomes (staged delete, reverted create, or a
            // mix) — see DeleteRecordsResponse for why (#147: one status code, multiple distinct
            // bodies isn't representable in OpenAPI without oneOf machinery this repo doesn't have).
            .Produces<DeleteRecordsResponse>()
            .ProducesProblem(400)
            .ProducesProblem(409);

        app.MapPost("/records/{formKey}/renumber", RenumberRecord)
            .WithName("RenumberRecord")
            .WithTags(Tag)
            .Produces<ChangeGroup>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422);

        app.MapPost("/plugins/{plugin}/records", CreateRecord)
            .WithName("CreateRecord")
            .WithTags(Tag)
            .Produces<MEditService.Core.Queries.CreateRecordResult>()
            .Produces<IReadOnlyList<ReferenceValidationError>>(422)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422);

        app.MapPost("/plugins/{plugin}/cells/{cellFormKey}/placed", CreatePlacedRecord)
            .WithName("CreatePlacedRecord")
            .WithTags(Tag)
            .Produces<MEditService.Core.Queries.CreateRecordResult>()
            .Produces<IReadOnlyList<ReferenceValidationError>>(422)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(422);
    }

    // Pending-change and change-group management: list, revert, save.
    private static void MapChangeManagementEndpoints(IEndpointRouteBuilder app)
    {
        app.MapGet("/change-groups", (IPendingChangeService changes, ILoggerFactory loggerFactory) =>
        {
            loggerFactory.CreateLogger(nameof(ChangeEndpoints)).LogInformation("Received GetChangeGroups");
            return Results.Ok(changes.GetChangeGroups());
        })
            .WithName("GetChangeGroups")
            .WithTags(Tag)
            .Produces<IReadOnlyList<ChangeGroup>>();

        app.MapGet("/changes", GetChanges)
            .WithName("GetChanges")
            .WithTags(Tag)
            .Produces<IReadOnlyList<PendingChange>>();

        app.MapDelete("/changes/group/{groupId}", DeleteChangeGroup)
            .WithName("DeleteChangeGroup")
            .WithTags(Tag)
            .Produces(204)
            .ProducesProblem(404);

        app.MapDelete("/changes/{changeId}", DeleteChange)
            .WithName("DeleteChange")
            .WithTags(Tag)
            .Produces(204)
            .ProducesProblem(404)
            .ProducesProblem(409);

        app.MapDelete("/changes", BulkDeleteChanges)
            .WithName("BulkDeleteChanges")
            .WithTags(Tag)
            .Produces<int>()
            .ProducesProblem(400);

        app.MapPost("/change-groups/{groupId}/save", SaveSingleGroup)
            .WithName("SaveChangeGroup")
            .WithTags(Tag)
            .Produces<SaveGroupResponse>()
            .ProducesProblem(400)
            .ProducesProblem(404)
            .ProducesProblem(409)
            .ProducesProblem(500);
    }

    internal static IResult PatchRecord(
        [FromRoute] string formKey,
        [FromBody] PatchRecordRequest req,
        ISessionManager session,
        IEditOrchestrator orchestrator,
        ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(ChangeEndpoints)).LogInformation("Received PatchRecord for {FormKey}", formKey);
        var s = session.Session;
        if (s == null) return Results.Problem(NoSessionMessage);

        var decoded = Uri.UnescapeDataString(formKey);
        return orchestrator.StageEdit(decoded, req.Plugin, req.Fields, req.Source ?? "user", req.Description, req.ChangeType).ToHttpResult();
    }

    private static IResult CopyRecordTo(
        [FromRoute] string formKey,
        [FromRoute] string targetPlugin,
        [FromBody] CopyRecordRequest req,
        IEditOrchestrator orchestrator,
        ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(ChangeEndpoints))
            .LogInformation("Received CopyRecordTo for {FormKey} to {TargetPlugin}", formKey, targetPlugin);
        var decodedFormKey = Uri.UnescapeDataString(formKey);
        var decodedTarget = Uri.UnescapeDataString(targetPlugin);
        return orchestrator.CopyRecordTo(decodedFormKey, decodedTarget, req.Source ?? "user").ToHttpResult();
    }

    private static IResult DeleteRecords(
        [FromBody] DeleteRecordsRequest req,
        IEditOrchestrator orchestrator,
        ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(ChangeEndpoints))
            .LogInformation("Received DeleteRecords for {Count} record(s)", req.Records?.Count ?? 0);
        var targets = (req.Records ?? []).Select(r => (r.FormKey, r.Plugin)).ToList();
        return targets.Count == 0
            ? Results.Problem("At least one record must be specified.", statusCode: 400)
            : orchestrator.DeleteRecords(targets, "user").ToHttpResult();
    }

    private static IResult GetChanges(
        [FromQuery] string? plugin,
        [FromQuery] string? formKey,
        [FromQuery] Guid? groupId,
        IRecordQueryService query,
        ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(ChangeEndpoints))
            .LogInformation("Received GetChanges for {Plugin} {FormKey} {GroupId}", plugin, formKey, groupId);
        var decodedPlugin = plugin != null ? Uri.UnescapeDataString(plugin) : null;
        var decodedFormKey = formKey != null ? Uri.UnescapeDataString(formKey) : null;
        return Results.Ok(query.GetChanges(decodedPlugin, decodedFormKey, groupId));
    }

    private static IResult DeleteChangeGroup(Guid groupId, IPendingChangeService changes, ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(ChangeEndpoints)).LogInformation("Received DeleteChangeGroup for {GroupId}", groupId);
        return changes.RevertGroup(groupId) ? Results.NoContent() : Results.NotFound();
    }

    private static IResult DeleteChange(Guid changeId, IPendingChangeService changes, ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(ChangeEndpoints)).LogInformation("Received DeleteChange for {ChangeId}", changeId);
        return changes.Revert(changeId) switch
        {
            RevertChangeResult.Reverted => Results.NoContent(),
            RevertChangeResult.NotFound => Results.NotFound(),
            RevertChangeResult.GroupOwned g => Results.Problem(
                $"Change belongs to group {g.GroupId} — revert the group first.", statusCode: 409),
            var r => throw new InvalidOperationException($"Unhandled RevertChangeResult: {r.GetType().Name}")
        };
    }

    private static IResult BulkDeleteChanges(
        [FromQuery] string? plugin,
        [FromQuery] string? formKey,
        IPendingChangeService changes,
        ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(ChangeEndpoints))
            .LogInformation("Received BulkDeleteChanges for {Plugin} {FormKey}", plugin, formKey);
        if (plugin == null && formKey == null)
            return Results.Problem("At least one of 'plugin' or 'formKey' must be specified.", statusCode: 400);
        var decodedPlugin = plugin != null ? Uri.UnescapeDataString(plugin) : null;
        var decodedFormKey = formKey != null ? Uri.UnescapeDataString(formKey) : null;
        return Results.Ok(changes.Revert(decodedPlugin, decodedFormKey));
    }

    private static IResult CreateRecord(
        [FromRoute] string plugin,
        [FromBody] CreateRecordRequest req,
        ISessionManager session,
        IEditOrchestrator orchestrator,
        ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(ChangeEndpoints))
            .LogInformation("Received CreateRecord for {Plugin} {RecordType}", plugin, req.RecordType);
        var s = session.Session;
        if (s == null) return Results.Problem(NoSessionMessage);

        var decodedPlugin = Uri.UnescapeDataString(plugin);

        var pluginMeta = s.Plugins.FirstOrDefault(p =>
            p.Name.Equals(decodedPlugin, StringComparison.OrdinalIgnoreCase));
        if (pluginMeta == null) return Results.NotFound();
        if (pluginMeta.IsImmutable)
            return Results.Problem($"'{decodedPlugin}' is a base-game plugin and cannot be edited.", statusCode: 409);

        try
        {
            return orchestrator.CreateRecord(pluginMeta.Name, req.RecordType, req.TemplateFormKey, req.Source ?? "user") switch
            {
                CreateRecordOutcome.Success ok => Results.Ok(new MEditService.Core.Queries.CreateRecordResult(ok.FormKey, ok.GroupId)),
                CreateRecordOutcome.InvalidReferences inv => Results.UnprocessableEntity(inv.Errors),
                CreateRecordOutcome.EslIneligible esl => StageEditResultExtensions.EslIneligibleProblem(esl.Plugin, esl.FormKeys),
                _ => Results.Problem("Unexpected error.")
            };
        }
        catch (ArgumentException ex)
        {
            loggerFactory.CreateLogger(nameof(ChangeEndpoints))
                .LogWarning(ex, "Rejected CreateRecord for {Plugin}", decodedPlugin);
            return Results.Problem(ex.Message, statusCode: 422);
        }
    }

    private static IResult CreatePlacedRecord(
        [FromRoute] string plugin,
        [FromRoute] string cellFormKey,
        [FromBody] CreatePlacedRecordRequest req,
        ISessionManager session,
        IEditOrchestrator orchestrator,
        ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(ChangeEndpoints))
            .LogInformation("Received CreatePlacedRecord for {Plugin} {CellFormKey} {RecordType}", plugin, cellFormKey, req.RecordType);
        var s = session.Session;
        if (s == null) return Results.Problem(NoSessionMessage);

        var decodedPlugin = Uri.UnescapeDataString(plugin);
        var decodedCellFormKey = Uri.UnescapeDataString(cellFormKey);

        var pluginMeta = s.Plugins.FirstOrDefault(p =>
            p.Name.Equals(decodedPlugin, StringComparison.OrdinalIgnoreCase));
        if (pluginMeta == null) return Results.NotFound();
        if (pluginMeta.IsImmutable)
            return Results.Problem($"'{decodedPlugin}' is a base-game plugin and cannot be edited.", statusCode: 409);

        try
        {
            return orchestrator.CreatePlacedRecord(pluginMeta.Name, req.RecordType, decodedCellFormKey, req.PlacementGroup, req.TemplateFormKey, req.Source ?? "user") switch
            {
                CreateRecordOutcome.Success ok => Results.Ok(new MEditService.Core.Queries.CreateRecordResult(ok.FormKey, ok.GroupId)),
                CreateRecordOutcome.InvalidReferences inv => Results.UnprocessableEntity(inv.Errors),
                CreateRecordOutcome.EslIneligible esl => StageEditResultExtensions.EslIneligibleProblem(esl.Plugin, esl.FormKeys),
                _ => Results.Problem("Unexpected error.")
            };
        }
        catch (ArgumentException ex)
        {
            loggerFactory.CreateLogger(nameof(ChangeEndpoints))
                .LogWarning(ex, "Rejected CreatePlacedRecord for {Plugin}", decodedPlugin);
            return Results.Problem(ex.Message, statusCode: 422);
        }
    }

    private static async Task<IResult> SaveSingleGroup(
        Guid groupId,
        PluginSaver saver,
        ISessionManager session,
        ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(ChangeEndpoints));
        logger.LogInformation("Received SaveChangeGroup for {GroupId}", groupId);
        if (session.Session == null) return Results.Problem(NoSessionMessage, statusCode: 400);

        try
        {
            return await saver.Save(groupId) switch
            {
                SaveGroupResult.NoChanges => Results.Problem("Change group not found.", statusCode: 404),
                SaveGroupResult.ImmutablePlugin im => Results.Problem(
                    $"'{im.Plugin}' is a base-game plugin and cannot be saved.", statusCode: 409),
                SaveGroupResult.Saved saved => Results.Ok(new SaveGroupResponse(saved.ByPlugin, saved.ReindexFailure)),
                var r => throw new InvalidOperationException($"Unhandled SaveGroupResult: {r.GetType().Name}")
            };
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to save change group {GroupId}", groupId);
            return Results.Problem(ex.Message);
        }
    }

    private static IResult RenumberRecord(
        [FromRoute] string formKey,
        [FromBody] RenumberRecordRequest req,
        IEditOrchestrator orchestrator,
        ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(ChangeEndpoints))
            .LogInformation("Received RenumberRecord for {FormKey} to {NewFormId}", formKey, req.NewFormId);
        var decoded = Uri.UnescapeDataString(formKey);
        return orchestrator.Renumber(decoded, req.NewFormId, req.Plugin, req.Source ?? "user") switch
        {
            RenumberResult.Staged ok => Results.Ok(ok.Group),
            RenumberResult.RecordNotFound => Results.NotFound(),
            RenumberResult.PluginImmutable p => Results.Problem(
                $"'{p.Plugin}' is immutable and cannot be edited.", statusCode: 409),
            RenumberResult.ImmutableReferences blocked => Results.Problem(
                statusCode: 409,
                title: "Immutable plugin holds a reference to this record.",
                extensions: new Dictionary<string, object?> { { "blockers", blocked.Blockers } }),
            RenumberResult.FormIdInUse => Results.Problem(
                "The requested FormID is already in use.", statusCode: 422),
            RenumberResult.EslIneligible esl => StageEditResultExtensions.EslIneligibleProblem(esl.Plugin, esl.FormKeys),
            RenumberResult.NoSession => Results.Problem(NoSessionMessage, statusCode: 400),
            var r => throw new InvalidOperationException($"Unhandled RenumberResult: {r.GetType().Name}")
        };
    }
}

public record PatchRecordRequest(
    string Plugin,
    Dictionary<string, JsonElement> Fields,
    string? Source,
    string? Description,
    string? ChangeType = null);

public record CreateRecordRequest(
    string RecordType,
    string? TemplateFormKey,
    string? Source);

public record CreatePlacedRecordRequest(
    string RecordType,
    string PlacementGroup,
    string? TemplateFormKey,
    string? Source);

public record CopyRecordRequest(string? Source);

public record RenumberRecordRequest(uint NewFormId, string Plugin, string? Source);
