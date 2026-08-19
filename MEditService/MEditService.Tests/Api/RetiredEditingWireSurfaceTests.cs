using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.Api;

/// <summary>
/// #410/ADR-0041: the retired pending-change and hidden-gitdir wire surface is gone from the
/// served OpenAPI document — the exact artifact <c>modbench/src/medit/generated/api.ts</c> is
/// generated from, so "absent here" is what makes the frontend unable to call it at all.
///
/// Every assertion below carries a <b>positive control</b>: a surviving sibling asserted present
/// through the identical query path. An absence assertion alone passes just as happily against an
/// empty document, a typo'd JSON pointer or a host that failed to map any endpoint; pairing it
/// with a survivor that must be found through the same lookup makes those failure modes visible.
/// </summary>
public sealed class RetiredEditingWireSurfaceTests
{
    private static async Task<JsonElement> GetSchemaAsync()
    {
        await using var app = new WebApplicationFactory<Program>();
        var client = app.CreateClient();
        var body = await client.GetStringAsync("/swagger/v1/swagger.json");
        return JsonDocument.Parse(body).RootElement.Clone();
    }

    private static IReadOnlyList<string> PathsOf(JsonElement root) =>
        [.. root.GetProperty("paths").EnumerateObject().Select(p => p.Name)];

    private static IReadOnlyList<string> SchemaNamesOf(JsonElement root) =>
        [.. root.GetProperty("components").GetProperty("schemas").EnumerateObject().Select(p => p.Name)];

    [Fact]
    public async Task OpenApiDocument_ExposesNoRetiredEditingOrLedgerPath()
    {
        var paths = PathsOf(await GetSchemaAsync());

        // Positive control, same list: the read surface this ticket must preserve is still routed.
        Assert.Contains("/records/{formKey}/compare", paths);
        Assert.Contains("/records/{formKey}/references", paths);
        Assert.Contains("/session/status", paths);

        string[] retired =
        [
            "/records/delete",
            "/records/{formKey}/copy-to/{targetPlugin}",
            "/records/{formKey}/renumber",
            "/plugins/{plugin}/records",
            "/plugins/{plugin}/cells/{cellFormKey}/placed",
            "/changes",
            "/changes/{changeId}",
            "/changes/group/{groupId}",
            "/change-groups",
            "/change-groups/{groupId}/save",
            "/ledger/status",
        ];
        Assert.Equal([], retired.Where(paths.Contains).ToArray());
    }

    [Fact]
    public async Task OpenApiDocument_RecordRoute_OffersNoMutatingVerb()
    {
        var root = await GetSchemaAsync();
        var operations = root.GetProperty("paths").GetProperty("/records/{formKey}")
            .EnumerateObject().Select(p => p.Name).ToList();

        // Positive control, same object: the record read is still served from this very route.
        Assert.Contains("get", operations);
        Assert.Equal([], operations.Where(verb => verb is "patch" or "post" or "put" or "delete").ToArray());
    }

    [Fact]
    public async Task OpenApiDocument_DeclaresNoRetiredPendingChangeOrLedgerSchema()
    {
        var schemas = SchemaNamesOf(await GetSchemaAsync());

        // Positive control, same list: the read models this ticket must preserve still generate.
        Assert.Contains("CompareResult", schemas);
        Assert.Contains("FieldValue", schemas);

        string[] retired =
        [
            "PendingChange",
            "ChangeGroup",
            "GroupMember",
            "StageEditResult",
            "SaveResult",
            "SaveGroupResponse",
            "DeleteRecordsResponse",
            "LedgerStatusEntry",
            "PatchRecordValidationError",
            "ReferenceValidationError",
        ];
        Assert.Equal([], retired.Where(schemas.Contains).ToArray());
    }
}
