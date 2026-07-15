using MEditService.Core.Edits;
using MEditService.Core.Queries;

namespace MEditService.Api.Endpoints;

public static class StageEditResultExtensions
{
    public static IResult ToHttpResult(this StageEditResult result) => result switch
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
        StageEditResult.EslIneligible esl => Results.Problem(
            detail: $"'{esl.Plugin}' can't be an ESL: {esl.FormKeys.Count} FormID(s) fall outside the ESL range (0x001–0xFFF): {string.Join(", ", esl.FormKeys)}",
            statusCode: 422),
        StageEditResult.Staged staged => Results.Ok(staged.Changes),
        var r => throw new InvalidOperationException($"Unhandled StageEditResult variant: {r.GetType().Name}")
    };

    public static IResult ToHttpResult(this DeleteRecordsResult result) => result switch
    {
        DeleteRecordsResult.NoSession => Results.Problem("No session loaded."),
        DeleteRecordsResult.PluginImmutable i => Results.Problem(
            $"'{i.Plugin}' is a base-game plugin and cannot be edited.", statusCode: 409),
        DeleteRecordsResult.BlockedByPendingGroup => Results.Problem(
            "Records have active group changes — revert groups first.", statusCode: 409),
        DeleteRecordsResult.BlockedByReferences b => Results.Problem(
            detail: "One or more records are referenced by immutable plugins and cannot be deleted.",
            statusCode: 409,
            extensions: new Dictionary<string, object?> { ["blockedBy"] = b.BlockedBy }),
        DeleteRecordsResult.Staged s => Results.Ok(s.Group),
        var r => throw new InvalidOperationException($"Unhandled DeleteRecordsResult variant: {r.GetType().Name}")
    };
}
