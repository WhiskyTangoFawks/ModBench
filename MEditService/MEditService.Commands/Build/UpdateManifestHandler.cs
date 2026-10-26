using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>The update manifest gesture: each mod's manifest from the mod as it is (ADR-0022). A mod lands or is refused on
/// its own, and a mod whose manifest is already so changes nothing.</summary>
public sealed class UpdateManifestHandler
{
    private readonly IModFolderRepository _repository;
    private readonly INotificationPublisher _notifications;

    internal UpdateManifestHandler(IModFolderRepository repository, INotificationPublisher notifications) =>
        (_repository, _notifications) = (repository, notifications);

    public async Task<UpdateManifestResult> UpdateManifestAsync(
        IReadOnlyList<ModToUpdate> mods, InstanceToUpdate instance, string? gesture, CancellationToken cancel)
    {
        var updated = await ModByMod.OverAsync(
            mods, mod => mod.Name, progress => _notifications.Publish(new UpdateManifestProgressNotification(progress)),
            (mod, _) => Task.FromResult(UpdateMod(mod, instance)), gesture, cancel);
        return updated.ToResult(
            landed => landed.Outcome,
            refused => new UpdateManifestRefused(refused.Item, refused.Refusal, refused.Message),
            (applied, refused) => new UpdateManifestResult(applied, refused));
    }

    private ItemAnswer<UpdateManifestRefusal, ModUpdated> UpdateMod(ModToUpdate mod, InstanceToUpdate instance)
    {
        if (mod.SourceFolder is { } sourceFolder) return LeftToItsBuild(mod, sourceFolder, instance);

        var installationFile = mod.InstallationFile;
        if (installationFile is not null && !_repository.InstallationFileExists(installationFile.Path))
        {
            return ItemAnswer<UpdateManifestRefusal, ModUpdated>.Refused(
                UpdateManifestRefusal.InstallationFileMissing,
                $"was not updated: '{_repository.InstallationFileName(installationFile.Path)}' not in the downloads folder.");
        }

        if (installationFile is null && instance.GameFolder is null && NamesTheGameFolder(mod))
        {
            return ItemAnswer<UpdateManifestRefusal, ModUpdated>.Refused(
                UpdateManifestRefusal.GameFolderNotFound, "was not updated: its manifest names the game folder, and the game folder was not found.");
        }

        Manifest manifest;
        ModFolderFiles read;
        try
        {
            read = _repository.Files(mod.Folder, mod.Name, mod.MetadataFiles.ToHashSet(StringComparer.Ordinal), instance.StatCache);
            manifest = new ManifestBuilder(installationFile is null ? null : (_repository.InstallationFileName(installationFile.Path), installationFile), instance.GameFolder)
                .Manifest(read.Files, mod.Version);
        }
        catch (DirectoryNotFoundException)
        {
            return ItemAnswer<UpdateManifestRefusal, ModUpdated>.Refused(UpdateManifestRefusal.ModFolderMissing, "was not updated: its folder does not exist.");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<UpdateManifestRefusal, ModUpdated>.Refused(
                UpdateManifestRefusal.ModFilesUnreadable, $"was not updated: a file could not be read: {e.Message}");
        }

        bool written;
        try
        {
            written = _repository.WriteManifest(mod.Folder, mod.Name, manifest);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<UpdateManifestRefusal, ModUpdated>.Refused(
                UpdateManifestRefusal.NotWritten, $"was not updated: its manifest could not be written: {e.Message}");
        }

        var statCacheNotWritten = _repository.KeepInStatCache(
            read, manifest, read.Files.ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal));
        return ItemAnswer<UpdateManifestRefusal, ModUpdated>.Landed(new ModUpdated(
            mod.Name, written, PathsWhere<PackageEntry.NotHeld>(manifest), PathsWhere<PackageEntry.OtherBytes>(manifest), statCacheNotWritten));
    }

    private static string[] PathsWhere<TEntry>(Manifest manifest) where TEntry : PackageEntry =>
        [.. manifest.Files.Where(file => file.Entry is TEntry).Select(file => file.Path).Order(StringComparer.Ordinal)];

    private bool NamesTheGameFolder(ModToUpdate mod)
    {
        try
        {
            return _repository.ReadManifest(mod.Folder, mod.Name)?.Package is ManifestPackage.GameFolder;
        }
        catch (Exception e) when (e is InvalidDataException or IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private ItemAnswer<UpdateManifestRefusal, ModUpdated> LeftToItsBuild(ModToUpdate mod, string sourceFolder, InstanceToUpdate instance)
    {
        var status = _repository.Status(mod.Folder, mod.Name, mod.MetadataFiles.ToHashSet(StringComparer.Ordinal), instance.StatCache, held: null, sourceFolder);
        if (status.Unreadable is { } unreadable)
            return ItemAnswer<UpdateManifestRefusal, ModUpdated>.Refused(UpdateManifestRefusal.ModFilesUnreadable, $"was not updated: {unreadable.Why}.");
        if (status.NoManifest)
        {
            return ItemAnswer<UpdateManifestRefusal, ModUpdated>.Refused(
                UpdateManifestRefusal.LeftToItsBuild, "was not updated: its build writes its manifest, and it has not written one.");
        }
        if (status.Differing.Count + status.NamedByNoLine.Count + status.Gone.Count > 0)
        {
            return ItemAnswer<UpdateManifestRefusal, ModUpdated>.Refused(
                UpdateManifestRefusal.LeftToItsBuild, "was not updated: its build writes its manifest, and its folder differs from what the build wrote.");
        }
        return ItemAnswer<UpdateManifestRefusal, ModUpdated>.Landed(new ModUpdated(mod.Name, ManifestWritten: false, status.NotInPackage, [], status.StatCacheNotWritten));
    }
}
