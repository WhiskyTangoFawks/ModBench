using MEditService.Core.Ledger;
using MEditService.Core.Session;

namespace MEditService.Api.Endpoints;

public static class LedgerEndpoints
{
    private const string Tag = "Ledger";

    public static IEndpointRouteBuilder MapLedgerEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/ledger/status", GetStatus)
            .WithName("GetLedgerStatus")
            .WithTags(Tag)
            .Produces<IReadOnlyList<LedgerStatusEntry>>();

        return app;
    }

    // #368: a read-only status projection, not a mutation — "no session loaded" is a true and
    // complete answer ("no tracked changes"), not an exceptional one, so this always answers 200
    // rather than the NoSessionMessage 400 the write endpoints use. Mirrors /session/status's own
    // always-200 shape, the closer precedent for a read.
    private static IResult GetStatus(ISessionManager session, LedgerStatusQuery query, ILoggerFactory loggerFactory)
    {
        loggerFactory.CreateLogger(nameof(LedgerEndpoints)).LogTrace("Received GetLedgerStatus");
        return Results.Ok(query.GetWorkingTreeChanges(session.Session));
    }
}
