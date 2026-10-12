using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>The Stage gesture: each mod's manifest from the mod as it is (ADR-0022). A mod lands or is refused on
/// its own, and a mod whose manifest is already so changes nothing.</summary>
public sealed class StageHandler(IModFolderRepository repository, INotificationPublisher notifications)
{
    public SelectionResult<string, StageRefusal, StagedMod> Stage(
        IReadOnlyList<ModToStage> mods, InstanceToStage instance, CancellationToken cancel = default)
    {
        var distinct = mods.DistinctBy(mod => mod.Name, StringComparer.OrdinalIgnoreCase).ToList();
        List<ItemLanded<string, StagedMod>> landed = [];
        List<ItemRefused<string, StageRefusal>> refused = [];
        try
        {
            foreach (var (mod, done) in distinct.Select((mod, done) => (mod, done)))
            {
                cancel.ThrowIfCancellationRequested();
                notifications.Publish(new StageProgressNotification(new StageProgress(mod.Name, done, distinct.Count)));
                switch (StageMod(mod, instance))
                {
                    case ItemAnswer<StageRefusal, StagedMod>.Wrote wrote:
                        landed.Add(new ItemLanded<string, StagedMod>(mod.Name, wrote.Outcome));
                        break;
                    case ItemAnswer<StageRefusal, StagedMod>.Refusing refusing:
                        refused.Add(new ItemRefused<string, StageRefusal>(mod.Name, refusing.Refusal, refusing.Message));
                        break;
                }
            }
        }
        finally
        {
            notifications.Publish(new StageProgressNotification(new StageProgress(null, 0, 0)));
        }
        return SelectionResult<string, StageRefusal, StagedMod>.PerItem(landed, refused);
    }

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

        Manifest manifest;
        try
        {
            var files = repository.Files(mod.Folder, mod.Name, mod.CommittedFiles.ToHashSet(StringComparer.Ordinal));
            List<(string Name, InstallationFileToStage File)> installationFiles =
                [.. mod.InstallationFiles.Select(file => (repository.InstallationFileName(file.Path), file))];
            var builder = new ManifestBuilder(installationFiles, instance.GameFiles);
            var providers = new DeltaMaker(repository, instance, mod.Folder, installationFiles)
                .Keep([.. files.Select(file => (file, builder.ProviderOf(file)))]);
            manifest = builder.Manifest([.. files.Zip(providers, (file, provider) => new ManifestFile(file.Path, file.Hash, file.Stamp, provider))]);
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
                StageRefusal.ManifestNotWritten, $"'{mod.Name}' was not staged: its manifest could not be written: {e.Message}");
        }

        return ItemAnswer<StageRefusal, StagedMod>.Landed(new StagedMod(
            written, [.. manifest.Files.Where(file => file.Provider is FileProvider.NoProvider).Select(file => file.Path).Order(StringComparer.Ordinal)]));
    }
}
