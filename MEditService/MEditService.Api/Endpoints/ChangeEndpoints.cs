using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Session;
using Microsoft.AspNetCore.Mvc;

namespace MEditService.Api.Endpoints;

public static class ChangeEndpoints
{
    public static IEndpointRouteBuilder MapChangeEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapMethods("/records/{formKey}", ["PATCH"],
            ([FromRoute] string formKey,
             [FromBody] PatchRecordRequest req,
             ISessionManager session,
             IEditOrchestrator orchestrator) =>
        {
            var s = session.Session;
            if (s == null) return Results.Problem("No session loaded.");

            var decoded = Uri.UnescapeDataString(formKey);
            var result = orchestrator.StageEdit(decoded, req.Plugin, req.Fields, req.Source ?? "user", req.Description);

            return result switch
            {
                StageEditResult.NoSession => Results.Problem("No session loaded."),
                StageEditResult.PluginImmutable i => Results.Problem(
                    $"'{i.Plugin}' is a base-game plugin and cannot be edited.", statusCode: 409),
                StageEditResult.BlockedByGroup g => Results.Problem(
                    $"This record has a pending group change — revert group {g.GroupId} first.", statusCode: 409),
                StageEditResult.RecordNotFound => Results.NotFound(),
                StageEditResult.ReadOnlyFields r => Results.Problem(
                    detail: $"The following fields are read-only and cannot be edited: {string.Join(", ", r.Fields)}",
                    statusCode: 422),
                StageEditResult.InvalidReferences inv => Results.UnprocessableEntity(inv.Errors),
                StageEditResult.Staged staged => Results.Ok(staged.Changes),
                _ => Results.Problem("Unexpected error.")
            };
        })
        .WithName("PatchRecord")
        .WithTags("Changes")
        .Produces<IReadOnlyList<PendingChange>>()
        .Produces<IReadOnlyList<ReferenceValidationError>>(422)
        .ProducesProblem(404)
        .ProducesProblem(409);

        app.MapPost("/records/{formKey}/copy-to/{targetPlugin}",
            ([FromRoute] string formKey,
             [FromRoute] string targetPlugin,
             [FromBody] CopyRecordRequest req,
             IEditOrchestrator orchestrator) =>
        {
            var decodedFormKey = Uri.UnescapeDataString(formKey);
            var decodedTarget = Uri.UnescapeDataString(targetPlugin);
            return orchestrator.CopyRecordTo(decodedFormKey, decodedTarget, req.Source ?? "user") switch
            {
                StageEditResult.NoSession => Results.Problem("No session loaded."),
                StageEditResult.PluginImmutable i => Results.Problem(
                    $"'{i.Plugin}' is a base-game plugin and cannot be edited.", statusCode: 409),
                StageEditResult.BlockedByGroup g => Results.Problem(
                    $"This record has a pending group change — revert group {g.GroupId} first.", statusCode: 409),
                StageEditResult.RecordNotFound => Results.NotFound(),
                StageEditResult.ReadOnlyFields r => Results.Problem(
                    detail: $"The following fields are read-only: {string.Join(", ", r.Fields)}", statusCode: 422),
                StageEditResult.Staged staged => Results.Ok(staged.Changes),
                _ => Results.Problem("Unexpected error.")
            };
        })
        .WithName("CopyRecordTo")
        .WithTags("Changes")
        .Produces<IReadOnlyList<PendingChange>>()
        .ProducesProblem(404)
        .ProducesProblem(409)
        .ProducesProblem(422);

        app.MapPost("/records/delete",
            ([FromBody] DeleteRecordsRequest req,
             IEditOrchestrator orchestrator) =>
        {
            var targets = (req.Records ?? []).Select(r => (r.FormKey, r.Plugin)).ToList();
            if (targets.Count == 0)
                return Results.Problem("At least one record must be specified.", statusCode: 400);
            return orchestrator.DeleteRecords(targets, "user") switch
            {
                DeleteRecordsResult.NoSession =>
                    Results.Problem("No session loaded."),
                DeleteRecordsResult.PluginImmutable i =>
                    Results.Problem($"'{i.Plugin}' is a base-game plugin and cannot be edited.", statusCode: 409),
                DeleteRecordsResult.BlockedByPendingGroup =>
                    Results.Problem("Records have active group changes — revert groups first.", statusCode: 409),
                DeleteRecordsResult.BlockedByReferences b =>
                    Results.Problem(
                        detail: "One or more records are referenced by immutable plugins and cannot be deleted.",
                        extensions: new Dictionary<string, object?> { ["blockedBy"] = b.BlockedBy },
                        statusCode: 409),
                DeleteRecordsResult.Staged s =>
                    Results.Ok(s.Group),
                _ => Results.Problem("Unexpected error.")
            };
        })
        .WithName("DeleteRecords")
        .WithTags("Changes")
        .Produces<ChangeGroup>()
        .ProducesProblem(400)
        .ProducesProblem(409);

        app.MapGet("/change-groups", (IPendingChangeService changes) =>
            Results.Ok(changes.GetChangeGroups()))
        .WithName("GetChangeGroups")
        .WithTags("Changes")
        .Produces<IReadOnlyList<ChangeGroup>>();

        app.MapGet("/changes", (
            [FromQuery] string? plugin,
            [FromQuery] string? formKey,
            [FromQuery] Guid? groupId,
            IPendingChangeService changes) =>
        {
            var decodedPlugin = plugin != null ? Uri.UnescapeDataString(plugin) : null;
            var decodedFormKey = formKey != null ? Uri.UnescapeDataString(formKey) : null;
            return Results.Ok(changes.GetChanges(decodedPlugin, decodedFormKey, groupId));
        })
        .WithName("GetChanges")
        .WithTags("Changes")
        .Produces<IReadOnlyList<PendingChange>>();

        app.MapDelete("/changes/group/{groupId}", (
            Guid groupId,
            IPendingChangeService changes) =>
        {
            return changes.RevertGroup(groupId) ? Results.NoContent() : Results.NotFound();
        })
        .WithName("DeleteChangeGroup")
        .WithTags("Changes")
        .Produces(204)
        .ProducesProblem(404);

        app.MapDelete("/changes/{changeId}", (
            Guid changeId,
            IPendingChangeService changes) =>
        {
            return changes.Revert(changeId) switch
            {
                RevertChangeResult.Reverted => Results.NoContent(),
                RevertChangeResult.NotFound => Results.NotFound(),
                RevertChangeResult.GroupOwned g => Results.Problem(
                    $"Change belongs to group {g.GroupId} — revert the group first.", statusCode: 409),
                var r => throw new InvalidOperationException($"Unhandled RevertChangeResult: {r.GetType().Name}")
            };
        })
        .WithName("DeleteChange")
        .WithTags("Changes")
        .Produces(204)
        .ProducesProblem(404)
        .ProducesProblem(409);

        app.MapDelete("/changes", (
            [FromQuery] string? plugin,
            [FromQuery] string? formKey,
            IPendingChangeService changes) =>
        {
            if (plugin == null && formKey == null)
                return Results.Problem("At least one of 'plugin' or 'formKey' must be specified.", statusCode: 400);
            var decodedPlugin = plugin != null ? Uri.UnescapeDataString(plugin) : null;
            var decodedFormKey = formKey != null ? Uri.UnescapeDataString(formKey) : null;
            var count = changes.Revert(decodedPlugin, decodedFormKey);
            return Results.Ok(count);
        })
        .WithName("BulkDeleteChanges")
        .WithTags("Changes")
        .Produces<int>()
        .ProducesProblem(400);

        app.MapPost("/plugins/{plugin}/records", (
            [FromRoute] string plugin,
            [FromBody] CreateRecordRequest req,
            ISessionManager session,
            IEditOrchestrator orchestrator) =>
        {
            var s = session.Session;
            if (s == null) return Results.Problem("No session loaded.");

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
                    _ => Results.Problem("Unexpected error.")
                };
            }
            catch (ArgumentException ex)
            {
                return Results.Problem(ex.Message, statusCode: 422);
            }
        })
        .WithName("CreateRecord")
        .WithTags("Changes")
        .Produces<MEditService.Core.Queries.CreateRecordResult>()
        .Produces<IReadOnlyList<ReferenceValidationError>>(422)
        .ProducesProblem(404)
        .ProducesProblem(409);

        app.MapPost("/plugins/{plugin}/save", async (
            [FromRoute] string plugin,
            IPendingChangeService changes,
            ISessionManager session,
            ILoggerFactory loggerFactory) =>
        {
            var logger = loggerFactory.CreateLogger(nameof(ChangeEndpoints));
            var decodedPlugin = Uri.UnescapeDataString(plugin);

            var s = session.Session;
            if (s == null) return Results.Problem("No session loaded.");

            var metadata = s.Plugins.FirstOrDefault(p =>
                string.Equals(p.Name, decodedPlugin, StringComparison.OrdinalIgnoreCase));
            if (metadata == null) return Results.NotFound();

            if (metadata.IsImmutable)
                return Results.Problem($"'{decodedPlugin}' is a base-game plugin and cannot be saved.", statusCode: 409);

            var drained = changes.DrainForPlugin(decodedPlugin);
            if (drained.Changes.Count == 0)
                return Results.Ok(new SaveResult(string.Empty, [], [], [], []));

            try
            {
                var result = await session.SavePlugin(decodedPlugin, drained.Changes);
                return Results.Ok(result);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to save plugin {Plugin} — re-queuing {Count} changes", decodedPlugin, drained.Changes.Count);
                foreach (var c in drained.Changes)
                {
                    var refsForField = drained.FormRefsByFormKey[c.FormKey]
                        .Where(r => r.StagedField == c.FieldPath)
                        .ToList();
                    changes.Upsert(c.FormKey, c.Plugin, c.RecordType,
                        new Dictionary<string, JsonElement> { [c.FieldPath] = c.NewValue },
                        c.Source, c.Description,
                        new Dictionary<string, JsonElement> { [c.FieldPath] = c.OldValue },
                        refsForField,
                        c.ChangeType);
                }
                return Results.Problem(ex.Message);
            }
        })
        .WithName("SavePlugin")
        .WithTags("Changes")
        .Produces<SaveResult>()
        .ProducesProblem(404)
        .ProducesProblem(409);

        return app;
    }
}

public record PatchRecordRequest(
    string Plugin,
    Dictionary<string, JsonElement> Fields,
    string? Source,
    string? Description);

public record CreateRecordRequest(
    string RecordType,
    string? TemplateFormKey,
    string? Source);

public record CopyRecordRequest(string? Source);
