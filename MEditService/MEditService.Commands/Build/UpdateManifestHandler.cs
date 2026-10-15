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
            read = repository.Files(mod.Folder, mod.Name, mod.MetadataFiles.ToHashSet(StringComparer.Ordinal), instance.StatCache);
            var builder = new ManifestBuilder(mod.InstallationFiles.Select(file => (repository.InstallationFileName(file.Path), file)), instance.GameFiles);
            manifest = builder.Manifest([.. read.Files.Select(file => new ManifestFile(file.Path, builder.ProviderOf(file)))], mod.Version);
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

    private bool NamesASource(ModToUpdate mod)
    {
        try
        {
            return repository.ReadManifest(mod.Folder, mod.Name)?.Files.Any(line => line.Provider is FileProvider.Source) ?? false;
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
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(UpdateManifestRefusal.ModFilesUnreadable, $"'{mod.Name}' was not updated: {unreadable.Why}.");
        if (status.NoManifest)
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(
                UpdateManifestRefusal.LeftToItsBuild, $"'{mod.Name}' was not updated: its build writes its manifest, and it has not written one.");
        }
        if (status.Differing.Count + status.NamedByNoLine.Count + status.Gone.Count > 0)
        {
            return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Refused(
                UpdateManifestRefusal.LeftToItsBuild, $"'{mod.Name}' was not updated: its build writes its manifest, and its folder differs from what the build wrote.");
        }
        return ItemAnswer<UpdateManifestRefusal, UpdatedMod>.Landed(new UpdatedMod(ManifestWritten: false, status.NoProvider, status.StatCacheNotWritten));
    }
}
