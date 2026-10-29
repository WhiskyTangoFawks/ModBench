using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.ModFolderAdapter;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands;

/// <summary>Validates the folders and the game release, applies the snapshot to Load order state as Mod Management
/// sent it (ADR-0013), and checks it for external changes (ADR-0003). The Index reconciles itself.</summary>
public sealed class PutLoadOrderHandler
{
    private readonly IModFolderRepository _modFolders;
    private readonly LoadOrderHolder _holder;
    private readonly SchemaReflector _schemaReflector;
    private readonly ExternalChangeCheck _externalChanges;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal PutLoadOrderHandler(
        IModFolderRepository modFolders, LoadOrderHolder holder, SchemaReflector schemaReflector, ExternalChangeCheck externalChanges) =>
        (_modFolders, _holder, _schemaReflector, _externalChanges) = (modFolders, holder, schemaReflector, externalChanges);

    public Answer<PutLoadOrderApplied, PutLoadOrderRefused> Put(
        string dataFolder, string? instanceRoot, GameRelease gameRelease,
        IReadOnlyList<RegisteredPlugin> plugins, IReadOnlyList<PluginAddress> active, IReadOnlyList<PluginAddress> loadedWithNoLine,
        IReadOnlyList<StampedFile> archives, IReadOnlyList<StampedFile> stringsFiles, IReadOnlyList<PluginPlace> places,
        Language stringsLanguage)
    {
        if (!_modFolders.DataFolderExists(dataFolder))
            return new PutLoadOrderRefused(PutLoadOrderRefusal.DataFolderNotFound, $"Data folder not found: {dataFolder}");

        // Discovered here, synchronously, never inside a reconcile the caller cannot see — the
        // schema this warms is what the reconcile that follows Apply needs anyway.
        try
        {
            _schemaReflector.GetSchemas(gameRelease);
        }
        catch (UnsupportedGameReleaseException ex)
        {
            return new PutLoadOrderRefused(PutLoadOrderRefusal.UnsupportedGameRelease, ex.Message);
        }

        if (LoadOrderSnapshot.RefusalOf(plugins, active, loadedWithNoLine) is { } invalid)
            return new PutLoadOrderRefused(PutLoadOrderRefusal.InvalidSnapshot, invalid);

        var snapshot = new LoadOrderSnapshot(dataFolder, instanceRoot, gameRelease, plugins, active, loadedWithNoLine, archives, stringsFiles, places, stringsLanguage);
        var version = _holder.Apply(snapshot);
        _externalChanges.Check(snapshot);
        return new PutLoadOrderApplied(version);
    }
}
