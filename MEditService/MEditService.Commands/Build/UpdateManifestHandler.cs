using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>The update manifest gesture: each mod's manifest from the mod as it is (ADR-0022). A mod lands or is refused on
/// its own, and a mod whose manifest is already so changes nothing.</summary>
public sealed class UpdateManifestHandler(IModFolderRepository repository, INotificationPublisher notifications)
{
    public SelectionResult<string, UpdateManifestRefusal, UpdatedMod> UpdateManifest(
        IReadOnlyList<ModToUpdate> mods, InstanceToUpdate instance, string? gesture = null, CancellationToken cancel = default) =>
        ModByMod.Over(
            mods, mod => mod.Name, progress => notifications.Publish(new UpdateManifestProgressNotification(progress)),
            mod => UpdateMod(mod, instance), gesture, cancel);

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

        Manifest manifest;
        ModFolderFiles read;
        try
        {
            read = repository.Files(mod.Folder, mod.Name, mod.CommittedFiles.ToHashSet(StringComparer.Ordinal), instance.StatCache);
            var builder = new ManifestBuilder(mod.InstallationFiles.Select(file => (repository.InstallationFileName(file.Path), file)), instance.GameFiles);
            manifest = builder.Manifest([.. read.Files.Select(file => new ManifestFile(file.Path, builder.ProviderOf(file)))]);
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

        var statCacheNotWritten = repository.KeepInStatCache(
            read, manifest, read.Files.ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal));
        return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Landed(new UpdatedMod(
            written, [.. manifest.Files.Where(file => file.Provider is FileProvider.NoProvider).Select(file => file.Path).Order(StringComparer.Ordinal)],
            statCacheNotWritten));
    }
}
