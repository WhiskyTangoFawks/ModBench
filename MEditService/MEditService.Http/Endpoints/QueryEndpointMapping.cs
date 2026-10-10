using System.ComponentModel;
using System.Diagnostics.CodeAnalysis;
using MEditService.Index.Queries;
using MEditService.RepositoriesLib;

namespace MEditService.Http.Endpoints;

/// <summary>The single-plugin read routes' shared origin guard (ADR-0012), and the one status each of the
/// Index's refusals takes.</summary>
internal static class QueryEndpointMapping
{
    internal static IResult Ok<T>(Answer<T, IndexRefused> answer) => Answered(answer, Results.Ok);

    internal static IResult Answered<T>(Answer<T, IndexRefused> answer, Func<T, IResult> onAnswered) =>
        answer.Holds(out var value, out var refused) ? onAnswered(value) : Refusal(refused);

    /// <summary>No load order, or an index not yet ready, is a "not right now", never a bad request.</summary>
    internal static IResult Refusal(IndexRefused refused) => Results.Problem(
        refused.Message,
        statusCode: refused.Refusal switch
        {
            IndexRefusal.NoLoadOrder or IndexRefusal.IndexNotReady => StatusCodes.Status503ServiceUnavailable,
            IndexRefusal.FilterRejected => StatusCodes.Status400BadRequest,
            IndexRefusal.SourceStopped => StatusCodes.Status422UnprocessableEntity,
            _ => throw new InvalidEnumArgumentException(nameof(refused), (int)refused.Refusal, typeof(IndexRefusal)),
        });

    internal static bool MissingOrigin(
        [NotNullWhen(false)] string? origin, [NotNullWhen(true)] out IResult? refusal)
    {
        if (string.IsNullOrWhiteSpace(origin))
        {
            refusal = Results.Problem("Origin is required.", statusCode: 400);
            return true;
        }
        refusal = null;
        return false;
    }
}
