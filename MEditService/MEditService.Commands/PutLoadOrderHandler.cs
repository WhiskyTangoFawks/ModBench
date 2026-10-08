using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands;

/// <summary>Validates the folders and the game release, applies the snapshot to Load order state as Mod Management
/// sent it (ADR-0013) and checks it for external changes (ADR-0003). The
/// Index reconciles on its own subscription.</summary>
public sealed class PutLoadOrderHandler
{
    private readonly IPluginAdapter _plugins;
    private readonly LoadOrderHolder _holder;
    private readonly SchemaReflector _schemaReflector;
    private readonly ExternalChangeCheck _externalChanges;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal PutLoadOrderHandler(
        IPluginAdapter plugins, LoadOrderHolder holder, SchemaReflector schemaReflector, ExternalChangeCheck externalChanges) =>
        (_plugins, _holder, _schemaReflector, _externalChanges) = (plugins, holder, schemaReflector, externalChanges);

    public PutLoadOrderResult Put(
        string dataFolder, string? instanceRoot, GameRelease gameRelease,
        IReadOnlyList<RegisteredPlugin> plugins, IReadOnlyList<PluginAddress> active, IReadOnlyList<PluginAddress> loadedWithNoLine)
    {
        if (!_plugins.GameFolderExists(dataFolder))
            return PutLoadOrderResult.Refused(PutLoadOrderRefusal.GameDirectoryNotFound, $"Game directory not found: {dataFolder}");
        if (!SourceRepository.InstanceRootExists(instanceRoot))
            return PutLoadOrderResult.Refused(PutLoadOrderRefusal.InstanceRootNotFound, $"Instance root not found: {instanceRoot}");

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

        if (LoadOrderSnapshot.RefusalOf(plugins, active, loadedWithNoLine) is { } invalid)
            return PutLoadOrderResult.Refused(PutLoadOrderRefusal.InvalidSnapshot, invalid);

        var snapshot = new LoadOrderSnapshot(dataFolder, instanceRoot, gameRelease, plugins, active, loadedWithNoLine);
        var version = _holder.Apply(snapshot);
        _externalChanges.Check(snapshot);
        return PutLoadOrderResult.Success(version);
    }
}
