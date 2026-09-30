using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands;

/// <summary>Validates the game release, prepends the forced plugins (ADR-0013 invariant 2), applies
/// the result to Load order state and checks it for external changes (ADR-0003 invariant 3). The
/// Index's reconcile is a subscription wired at composition.</summary>
public sealed class PutLoadOrderHandler
{
    private readonly LoadOrderHolder _holder;
    private readonly SchemaReflector _schemaReflector;
    private readonly IPluginAdapter _adapter;
    private readonly ExternalChangeCheck _externalChanges;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal PutLoadOrderHandler(
        LoadOrderHolder holder, SchemaReflector schemaReflector, IPluginAdapter adapter, ExternalChangeCheck externalChanges) =>
        (_holder, _schemaReflector, _adapter, _externalChanges) = (holder, schemaReflector, adapter, externalChanges);

    public PutLoadOrderResult Put(
        string dataFolder, string? instanceRoot, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> entries)
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
        var version = _holder.Apply(snapshot);
        _externalChanges.Check(snapshot);
        return PutLoadOrderResult.Success(version);
    }

    // A sent entry naming a forced plugin is dropped, so one file never registers twice; what a
    // forced row is stays the kernel's.
    private IReadOnlyList<RegisteredPlugin> WithForcedFirst(
        string dataFolder, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> entries)
    {
        var names = _adapter.ImplicitPluginsIn(dataFolder, gameRelease);
        var forcedNames = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
        var forced = names.Select((name, slot) => RegisteredPlugin.Forced(dataFolder, name, slot)).ToList();

        return
        [
            .. forced,
            .. entries
                .Where(e => !forcedNames.Contains(e.Name))
                .Select(e => RegisteredPlugin.Of(e, slotOffset: forced.Count)),
        ];
    }
}
