using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>The update manifest gesture: each mod's manifest from the mod as it is (ADR-0022). A mod lands or is refused on
/// its own, and a mod whose manifest is already so changes nothing.</summary>
public sealed class UpdateManifestHandler(IModFolderRepository repository, INotificationPublisher notifications)
{
    public Task<SelectionResult<string, UpdateManifestRefusal, UpdatedMod>> UpdateManifestAsync(
        IReadOnlyList<ModToUpdate> mods, InstanceToUpdate instance, string? gesture = null, CancellationToken cancel = default) =>
        ModByMod.OverAsync(
            mods, mod => mod.Name, progress => notifications.Publish(new UpdateManifestProgressNotification(progress)),
            mod => Task.FromResult(UpdateMod(mod, instance)), gesture, cancel);

    private ItemAnswer<UpdateManifestRefusal, UpdatedMod> UpdateMod(ModToUpdate mod, InstanceToUpdate instance)
    {
        if (mod.IsSourceMod || NamesASource(mod)) return LeftToItsBuild(mod, instance);

        var installationFile = mod.InstallationFiles.Count > 0 ? mod.InstallationFiles[0] : null;
        if (installationFile is not null && !repository.InstallationFileExists(installationFile.Path))
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(
                UpdateManifestRefusal.InstallationFileMissing,
                $"was not updated: '{repository.InstallationFileName(installationFile.Path)}' not in the downloads folder.");
        }

        Manifest manifest;
        ModFolderFiles read;
        try
        {
            read = repository.Files(mod.Folder, mod.Name, mod.MetadataFiles.ToHashSet(StringComparer.Ordinal), instance.StatCache);
            manifest = new ManifestBuilder(installationFile is null ? null : (repository.InstallationFileName(installationFile.Path), installationFile))
                .Manifest(read.Files, mod.Version);
        }
        catch (DirectoryNotFoundException)
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(UpdateManifestRefusal.ModFolderMissing, "was not updated: its folder does not exist.");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(
                UpdateManifestRefusal.ModFilesUnreadable, $"was not updated: a file could not be read: {e.Message}");
        }

        bool written;
        try
        {
            written = repository.WriteManifest(mod.Folder, mod.Name, manifest);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(
                UpdateManifestRefusal.NotWritten, $"was not updated: its manifest could not be written: {e.Message}");
        }

        var statCacheNotWritten = repository.KeepInStatCache(
            read, manifest, read.Files.ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal));
        return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Landed(new UpdatedMod(
            written, [.. manifest.Files.Where(file => file.Entry is PackageEntry.NotHeld).Select(file => file.Path).Order(StringComparer.Ordinal)],
            statCacheNotWritten));
    }

    private bool NamesASource(ModToUpdate mod)
    {
        try
        {
            return repository.ReadManifest(mod.Folder, mod.Name)?.Package is ManifestPackage.SourceMod;
        }
        catch (Exception e) when (e is InvalidDataException or IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private ItemAnswer<UpdateManifestRefusal, UpdatedMod> LeftToItsBuild(ModToUpdate mod, InstanceToUpdate instance)
    {
        var status = repository.Status(mod.Folder, mod.Name, mod.MetadataFiles.ToHashSet(StringComparer.Ordinal), instance.StatCache);
        if (status.Unreadable is { } unreadable)
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(UpdateManifestRefusal.ModFilesUnreadable, $"was not updated: {unreadable.Why}.");
        if (status.NoManifest)
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(
                UpdateManifestRefusal.LeftToItsBuild, "was not updated: its build writes its manifest, and it has not written one.");
        }
        if (status.Differing.Count + status.NamedByNoLine.Count + status.Gone.Count > 0)
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(
                UpdateManifestRefusal.LeftToItsBuild, "was not updated: its build writes its manifest, and its folder differs from what the build wrote.");
        }
        return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Landed(new UpdatedMod(ManifestWritten: false, status.NotInPackage, status.StatCacheNotWritten));
    }
}
