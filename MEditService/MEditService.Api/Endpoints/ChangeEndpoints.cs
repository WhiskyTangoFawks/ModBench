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
             IRecordQueryService query,
             IPendingChangeService changes,
             ISessionManager session,
             IPluginWriter writer) =>
        {
            var s = session.Session;
            if (s == null) return Results.Problem("No session loaded.");

            var pluginMeta = s.Plugins.FirstOrDefault(p =>
                string.Equals(p.Name, req.Plugin, StringComparison.OrdinalIgnoreCase));
            if (pluginMeta?.IsImmutable == true)
                return Results.Problem($"'{req.Plugin}' is a base-game plugin and cannot be edited.", statusCode: 409);

            var decoded = Uri.UnescapeDataString(formKey);

            var recordType = query.GetRecordType(decoded);
            if (recordType == null) return Results.NotFound();

            // Reject read-only fields before staging the change
            var readOnlyFields = req.Fields.Keys
                .Where(f => writer.IsReadOnly(s.GameRelease, recordType, f))
                .ToList();
            if (readOnlyFields.Count > 0)
                return Results.Problem(
                    detail: $"The following fields are read-only and cannot be edited: {string.Join(", ", readOnlyFields)}",
                    statusCode: 422);

            var currentRecord = query.GetRecordForPlugin(decoded, req.Plugin);
            var oldValues = new Dictionary<string, JsonElement>();
            if (currentRecord != null)
            {
                foreach (var fv in currentRecord.Fields)
                {
                    if (req.Fields.ContainsKey(fv.Metadata.Name))
                        oldValues[fv.Metadata.Name] = JsonSerializer.SerializeToElement(fv.Value);
                }
            }

            var result = changes.Upsert(decoded, req.Plugin, recordType, req.Fields,
                req.Source ?? "user", req.Description, oldValues);
            return Results.Ok(result);
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
            IRecordQueryService query,
            IPendingChangeService changes,
            ISessionManager session) =>
        {
            var decoded       = Uri.UnescapeDataString(formKey);
            var decodedTarget = Uri.UnescapeDataString(targetPlugin);

            var s = session.Session;
            if (s == null) return Results.Problem("No session loaded.");

            var targetMeta = s.Plugins.FirstOrDefault(p =>
                string.Equals(p.Name, decodedTarget, StringComparison.OrdinalIgnoreCase));
            if (targetMeta?.IsImmutable == true)
                return Results.Problem($"'{decodedTarget}' is a base-game plugin and cannot be edited.", statusCode: 409);

            var recordType = query.GetRecordType(decoded);
            if (recordType == null) return Results.NotFound();

            var winner = query.GetRecord(decoded);
            if (winner == null) return Results.NotFound();

            var fields = winner.Fields.ToDictionary(
                fv => fv.Metadata.Name,
                fv => JsonSerializer.SerializeToElement(fv.Value));

            var currentTarget = query.GetRecordForPlugin(decoded, decodedTarget);
            var oldValues = new Dictionary<string, JsonElement>();
            if (currentTarget != null)
            {
                foreach (var fv in currentTarget.Fields)
                    oldValues[fv.Metadata.Name] = JsonSerializer.SerializeToElement(fv.Value);
            }

            var result = changes.Upsert(decoded, decodedTarget, recordType, fields, source ?? "user", null, oldValues);
            return Results.Ok(result);
        })
        .WithName("CopyRecordTo")
        .WithTags("Changes");

        app.MapPost("/plugins/{plugin}/save", async (
            [FromRoute] string plugin,
            IPendingChangeService changes,
            ISessionManager session,
            IPluginWriter writer) =>
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
                var result = await writer.SaveAsync(
                    metadata.Path, pending, session.Repository!, metadata.LoadOrderIndex, s.GameRelease);
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
