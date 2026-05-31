using System.Text.Json;
using MEditService.Core.Edits;
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
                StageEditResult.NoSession        => Results.Problem("No session loaded."),
                StageEditResult.PluginImmutable i => Results.Problem(
                    $"'{i.Plugin}' is a base-game plugin and cannot be edited.", statusCode: 409),
                StageEditResult.RecordNotFound   => Results.NotFound(),
                StageEditResult.ReadOnlyFields r  => Results.Problem(
                    detail: $"The following fields are read-only and cannot be edited: {string.Join(", ", r.Fields)}",
                    statusCode: 422),
                StageEditResult.Staged staged      => Results.Ok(staged.Changes),
                _                                 => Results.Problem("Unexpected error.")
            };
        })
        .WithName("PatchRecord")
        .WithTags("Changes");

        app.MapGet("/changes", (
            [FromQuery] string? plugin,
            [FromQuery] string? formKey,
            IPendingChangeService changes) =>
        {
            var decodedPlugin  = plugin  != null ? Uri.UnescapeDataString(plugin)  : null;
            var decodedFormKey = formKey != null ? Uri.UnescapeDataString(formKey) : null;
            return Results.Ok(changes.GetChanges(decodedPlugin, decodedFormKey));
        })
        .WithName("GetChanges")
        .WithTags("Changes");

        app.MapDelete("/changes/{changeId}", (
            Guid changeId,
            IPendingChangeService changes) =>
        {
            var removed = changes.Revert(changeId);
            return removed ? Results.NoContent() : Results.NotFound();
        })
        .WithName("DeleteChange")
        .WithTags("Changes");

        app.MapDelete("/changes", (
            [FromQuery] string? plugin,
            [FromQuery] string? formKey,
            IPendingChangeService changes) =>
        {
            var decodedPlugin  = plugin  != null ? Uri.UnescapeDataString(plugin)  : null;
            var decodedFormKey = formKey != null ? Uri.UnescapeDataString(formKey) : null;
            var count = changes.Revert(decodedPlugin, decodedFormKey);
            return Results.Ok(new { removed = count });
        })
        .WithName("BulkDeleteChanges")
        .WithTags("Changes");

        app.MapPost("/records/{formKey}/copy-to/{targetPlugin}", (
            [FromRoute] string formKey,
            [FromRoute] string targetPlugin,
            [FromQuery] string? source,
            ISessionManager session,
            IEditOrchestrator orchestrator) =>
        {
            var s = session.Session;
            if (s == null) return Results.Problem("No session loaded.");

            var decoded       = Uri.UnescapeDataString(formKey);
            var decodedTarget = Uri.UnescapeDataString(targetPlugin);

            var result = orchestrator.CopyRecordTo(decoded, decodedTarget, source ?? "user");

            return result switch
            {
                StageEditResult.NoSession        => Results.Problem("No session loaded."),
                StageEditResult.PluginImmutable i => Results.Problem(
                    $"'{i.Plugin}' is a base-game plugin and cannot be edited.", statusCode: 409),
                StageEditResult.RecordNotFound   => Results.NotFound(),
                StageEditResult.Staged staged      => Results.Ok(staged.Changes),
                _                                 => Results.Problem("Unexpected error.")
            };
        })
        .WithName("CopyRecordTo")
        .WithTags("Changes");

        app.MapPost("/plugins/{plugin}/save", async (
            [FromRoute] string plugin,
            IPendingChangeService changes,
            ISessionManager session) =>
        {
            var decodedPlugin = Uri.UnescapeDataString(plugin);

            var s = session.Session;
            if (s == null) return Results.Problem("No session loaded.");

            var metadata = s.Plugins.FirstOrDefault(p =>
                string.Equals(p.Name, decodedPlugin, StringComparison.OrdinalIgnoreCase));
            if (metadata == null) return Results.NotFound();

            if (metadata.IsImmutable)
                return Results.Problem($"'{decodedPlugin}' is a base-game plugin and cannot be saved.", statusCode: 409);

            var pending = changes.DrainForPlugin(decodedPlugin);
            if (pending.Count == 0)
                return Results.Ok(new { backupPath = (string?)null, applied = Array.Empty<string>(), readOnly = Array.Empty<string>(), notFound = Array.Empty<string>() });

            try
            {
                var result = await session.SavePlugin(decodedPlugin, pending);
                return Results.Ok(new
                {
                    backupPath = result.BackupPath,
                    applied    = result.Applied,
                    readOnly   = result.ReadOnly,
                    notFound   = result.NotFound,
                });
            }
            catch (Exception ex)
            {
                // Re-queue the drained changes so they are not lost on error
                foreach (var c in pending)
                    changes.Upsert(c.FormKey, c.Plugin, c.RecordType,
                        new Dictionary<string, JsonElement> { [c.FieldPath] = c.NewValue },
                        c.Source, c.Description,
                        new Dictionary<string, JsonElement> { [c.FieldPath] = c.OldValue });

                return Results.Problem(ex.Message);
            }
        })
        .WithName("SavePlugin")
        .WithTags("Changes");

        return app;
    }
}

public record PatchRecordRequest(
    string Plugin,
    Dictionary<string, JsonElement> Fields,
    string? Source,
    string? Description);
