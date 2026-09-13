using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.Commands;

/// <summary>ADR-0013: validates the entries, builds the snapshot and applies it to Load order
/// state. Reconciling into the Index and re-arming the watcher are their own subscriptions at
/// composition (ADR-0014 invariant 3).</summary>
public sealed class PutLoadOrderHandler
{
    private readonly LoadOrderHolder _holder;
    private readonly SchemaReflector _schemaReflector;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal PutLoadOrderHandler(LoadOrderHolder holder, SchemaReflector schemaReflector) =>
        (_holder, _schemaReflector) = (holder, schemaReflector);

    public PutLoadOrderResult Put(
        IReadOnlyList<LoadOrderEntry> entries, string gameDirectory, string instanceRoot, string gameRelease)
    {
        if (!Directory.Exists(gameDirectory))
        {
            return PutLoadOrderResult.Refused(
                PutLoadOrderRefusal.GameDirectoryNotFound, $"Game directory not found: {gameDirectory}");
        }
        // ADR-0009: the MO2 instance root is what the index file is keyed on, so a snapshot that
        // cannot name one has nowhere to keep its rows — a bad request, not a degraded reconcile.
        if (!Directory.Exists(instanceRoot))
        {
            return PutLoadOrderResult.Refused(
                PutLoadOrderRefusal.InstanceRootNotFound, $"Instance root not found: {instanceRoot}");
        }
        if (!Enum.TryParse<GameRelease>(gameRelease, out var release))
        {
            return PutLoadOrderResult.Refused(PutLoadOrderRefusal.UnknownGameRelease,
                $"Unknown game release: '{gameRelease}'. Valid values: {string.Join(", ", Enum.GetNames<GameRelease>())}");
        }

        // Discovered here, synchronously, never inside a reconcile the caller cannot see — the
        // schema this warms is what the reconcile that follows Apply needs anyway.
        try
        {
            _schemaReflector.GetSchemas(release);
        }
        catch (UnsupportedGameReleaseException ex)
        {
            return PutLoadOrderResult.Refused(PutLoadOrderRefusal.UnsupportedGameRelease, ex.Message);
        }

        _holder.Apply(ForcedPlugins.Snapshot(gameDirectory, instanceRoot, release, entries));
        return PutLoadOrderResult.Success();
    }
}
