using System.Diagnostics.CodeAnalysis;

namespace MEditService.Http.Endpoints;

/// <summary>The single-plugin read routes' shared origin guard (ADR-0012 invariant 1): six routes
/// each need it, so one copy is the one that can't drift from the others.</summary>
internal static class QueryEndpointMapping
{
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
