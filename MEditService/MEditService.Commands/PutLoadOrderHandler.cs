using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands;

/// <summary>Validates the game release, prepends the forced plugins (ADR-0013 invariant 2) and
/// applies the result to Load order state. Reconciling into the Index and re-arming the watcher
/// are subscriptions wired at composition, so a snapshot identical to the one held, while the Index
/// holds that one, is a no-op here (ADR-0013 invariant 1).</summary>
public sealed class PutLoadOrderHandler
{
    private readonly LoadOrderHolder _holder;
    private readonly SchemaReflector _schemaReflector;
    private readonly IPluginAdapter _adapter;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal PutLoadOrderHandler(LoadOrderHolder holder, SchemaReflector schemaReflector, IPluginAdapter adapter) =>
        (_holder, _schemaReflector, _adapter) = (holder, schemaReflector, adapter);

    /// <summary><paramref name="indexHoldsCurrent"/>: whether the Index holds the load order held
    /// now, or is reconciling it. False after a rebuild, a refusal or a failure, when the same
    /// snapshot is the retry.</summary>
    public PutLoadOrderResult Put(
        string dataFolder, string? instanceRoot, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> entries,
        bool indexHoldsCurrent)
    {
        // Discovered here, synchronously, never inside a reconcile the caller cannot see — the
        // schema this warms is what the reconcile that follows Apply needs anyway.
        try
        {
            _schemaReflector.GetSchemas(gameRelease);
        }
        catch (UnsupportedGameReleaseException ex)
        {
            return PutLoadOrderResult.Refused(PutLoadOrderRefusal.UnsupportedGameRelease, ex.Message);
        }

        var snapshot = new LoadOrderSnapshot(dataFolder, instanceRoot, gameRelease, WithForcedFirst(dataFolder, gameRelease, entries));
        if (indexHoldsCurrent && snapshot.Equals(_holder.Current)) return PutLoadOrderResult.Success(_holder.Version);
        return PutLoadOrderResult.Success(_holder.Apply(snapshot));
    }

    // A sent entry naming a forced plugin is dropped, so one file never registers twice; what a
    // forced row is stays the kernel's.
    private IReadOnlyList<RegisteredCopy> WithForcedFirst(
        string dataFolder, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> entries)
    {
        var names = _adapter.ImplicitPluginsIn(dataFolder, gameRelease);
        var forcedNames = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
        var forced = names.Select((name, slot) => RegisteredCopy.Forced(dataFolder, name, slot)).ToList();

        return
        [
            .. forced,
            .. entries
                .Where(e => !forcedNames.Contains(e.Name))
                .Select(e => RegisteredCopy.Of(e, slotOffset: forced.Count)),
        ];
    }
}
