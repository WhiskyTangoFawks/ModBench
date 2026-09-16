using MEditService.Codec.Schema;
using MEditService.LoadOrder;

namespace MEditService.Commands;

/// <summary>ADR-0013: validates the snapshot's game release is supported and applies it to Load
/// order state. Reconciling into the Index and re-arming the watcher are their own subscriptions
/// at composition (ADR-0014 invariant 3).</summary>
public sealed class PutLoadOrderHandler
{
    private readonly LoadOrderHolder _holder;
    private readonly SchemaReflector _schemaReflector;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal PutLoadOrderHandler(LoadOrderHolder holder, SchemaReflector schemaReflector) =>
        (_holder, _schemaReflector) = (holder, schemaReflector);

    public PutLoadOrderResult Put(LoadOrderSnapshot snapshot)
    {
        // Discovered here, synchronously, never inside a reconcile the caller cannot see — the
        // schema this warms is what the reconcile that follows Apply needs anyway.
        try
        {
            _schemaReflector.GetSchemas(snapshot.GameRelease);
        }
        catch (UnsupportedGameReleaseException ex)
        {
            return PutLoadOrderResult.Refused(PutLoadOrderRefusal.UnsupportedGameRelease, ex.Message);
        }

        var version = _holder.Apply(snapshot);
        return PutLoadOrderResult.Success(version);
    }
}
