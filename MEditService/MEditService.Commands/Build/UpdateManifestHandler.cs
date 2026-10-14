using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>The update manifest gesture: each mod's manifest from the mod as it is (ADR-0022). A mod lands or is refused on
/// its own, and a mod whose manifest is already so changes nothing.</summary>
public sealed class UpdateManifestHandler(IModFolderRepository repository, INotificationPublisher notifications)
{
    public SelectionResult<string, UpdateManifestRefusal, UpdatedMod> UpdateManifest(
        IReadOnlyList<ModToUpdate> mods, InstanceToUpdate instance, CancellationToken cancel = default) =>
        ModByMod.Over(
            mods, mod => mod.Name, progress => notifications.Publish(new UpdateManifestProgressNotification(progress)), mod => UpdateMod(mod, instance), cancel);

    private ItemAnswer<UpdateManifestRefusal, UpdatedMod> UpdateMod(ModToUpdate mod, InstanceToUpdate instance)
    {
        var missing = mod.InstallationFiles.Where(file => !repository.InstallationFileExists(file.Path))
            .Select(file => $"'{repository.InstallationFileName(file.Path)}'").ToList();
        if (missing.Count > 0)
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(
                UpdateManifestRefusal.InstallationFileMissing,
                $"'{mod.Name}' was not updated: {string.Join(", ", missing)} not in the downloads folder.");
        }

        List<(string Name, InstallationFile File)> installationFiles =
            [.. mod.InstallationFiles.Select(file => (repository.InstallationFileName(file.Path), file))];
        var deltas = new DeltaMaker(repository, instance, mod.Folder, installationFiles);
        Manifest manifest;
        try
        {
            var files = repository.Files(mod.Folder, mod.Name, mod.CommittedFiles.ToHashSet(StringComparer.Ordinal));
            var builder = new ManifestBuilder(installationFiles, instance.GameFiles);
            var providers = deltas.Keep([.. files.Select(file => (file, builder.ProviderOf(file)))]);
            manifest = builder.Manifest([.. files.Zip(providers, (file, provider) => new ManifestFile(file.Path, file.Hash, file.Stamp, provider))]);
        }
        catch (Exception e) when (deltas.NotWritten && e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(
                UpdateManifestRefusal.NotWritten, $"'{mod.Name}' was not updated: a delta could not be written: {e.Message}");
        }
        catch (DirectoryNotFoundException)
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(UpdateManifestRefusal.ModFolderMissing, $"'{mod.Name}' was not updated: its folder does not exist.");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(
                UpdateManifestRefusal.ModFilesUnreadable, $"'{mod.Name}' was not updated: a file could not be read: {e.Message}");
        }

        bool written;
        try
        {
            written = repository.WriteManifest(mod.Folder, mod.Name, manifest);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(
                UpdateManifestRefusal.NotWritten, $"'{mod.Name}' was not updated: its manifest could not be written: {e.Message}");
        }

        return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Landed(new UpdatedMod(
            written, [.. manifest.Files.Where(file => file.Provider is FileProvider.NoProvider).Select(file => file.Path).Order(StringComparer.Ordinal)]));
    }
}
