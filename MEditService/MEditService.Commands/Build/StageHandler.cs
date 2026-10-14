using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>The Stage gesture: each mod's manifest from the mod as it is (ADR-0022). A mod lands or is refused on
/// its own, and a mod whose manifest is already so changes nothing.</summary>
public sealed class StageHandler(IModFolderRepository repository, INotificationPublisher notifications)
{
    public SelectionResult<string, StageRefusal, StagedMod> Stage(
        IReadOnlyList<ModToStage> mods, InstanceToStage instance, CancellationToken cancel = default) =>
        ModByMod.Over(
            mods, mod => mod.Name, progress => notifications.Publish(new StageProgressNotification(progress)), mod => StageMod(mod, instance), cancel);

    private ItemAnswer<StageRefusal, StagedMod> StageMod(ModToStage mod, InstanceToStage instance)
    {
        var missing = mod.InstallationFiles.Where(file => !repository.InstallationFileExists(file.Path))
            .Select(file => $"'{repository.InstallationFileName(file.Path)}'").ToList();
        if (missing.Count > 0)
        {
            return ItemAnswer<StageRefusal, StagedMod>.Refused(
                StageRefusal.InstallationFileMissing,
                $"'{mod.Name}' was not staged: {string.Join(", ", missing)} not in the downloads folder.");
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
            return ItemAnswer<StageRefusal, StagedMod>.Refused(
                StageRefusal.NotWritten, $"'{mod.Name}' was not staged: a delta could not be written: {e.Message}");
        }
        catch (DirectoryNotFoundException)
        {
            return ItemAnswer<StageRefusal, StagedMod>.Refused(StageRefusal.ModFolderMissing, $"'{mod.Name}' was not staged: its folder does not exist.");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<StageRefusal, StagedMod>.Refused(
                StageRefusal.ModFilesUnreadable, $"'{mod.Name}' was not staged: a file could not be read: {e.Message}");
        }

        bool written;
        try
        {
            written = repository.WriteManifest(mod.Folder, mod.Name, manifest);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<StageRefusal, StagedMod>.Refused(
                StageRefusal.NotWritten, $"'{mod.Name}' was not staged: its manifest could not be written: {e.Message}");
        }

        return ItemAnswer<StageRefusal, StagedMod>.Landed(new StagedMod(
            written, [.. manifest.Files.Where(file => file.Provider is FileProvider.NoProvider).Select(file => file.Path).Order(StringComparer.Ordinal)]));
    }
}
