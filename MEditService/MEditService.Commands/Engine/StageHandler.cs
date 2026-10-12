using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Engine;

/// <summary>The Stage gesture: each mod's manifest from the mod as it is (ADR-0022). A mod lands or is refused on
/// its own, and a mod whose manifest is already so changes nothing.</summary>
public sealed class StageHandler(IModFolderRepository repository, INotificationPublisher notifications, TimeProvider time)
{
    private readonly ContentHashes _hashes = new(repository, time);

    public SelectionResult<string, StageRefusal, StagedMod> Stage(
        IReadOnlyList<ModToStage> mods, string gameFolder, CancellationToken cancel = default)
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
                switch (StageMod(mod, gameFolder))
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

    private ItemAnswer<StageRefusal, StagedMod> StageMod(ModToStage mod, string gameFolder)
    {
        List<(InstallationFileToStage File, StampedFile Stamped)> described = [];
        List<string> missing = [];
        foreach (var file in mod.InstallationFiles)
        {
            if (repository.InstallationFile(file.Path) is { } stamped) described.Add((file, stamped));
            else missing.Add($"'{repository.InstallationFileName(file.Path)}'");
        }

        if (missing.Count > 0)
        {
            return ItemAnswer<StageRefusal, StagedMod>.Refused(
                StageRefusal.InstallationFileMissing,
                $"'{mod.Name}' was not staged: {string.Join(", ", missing)} not in the downloads folder.");
        }

        List<(string Name, string? Source, HashedInstallationFile Content)> installationFiles = [];
        foreach (var (file, stamped) in described)
        {
            var name = repository.InstallationFileName(file.Path);
            try
            {
                installationFiles.Add((name, file.Source, _hashes.OfInstallationFile(stamped)));
            }
            catch (Exception e) when (e is IOException or InvalidOperationException or InvalidDataException or NotSupportedException
                or SharpCompress.Common.SharpCompressException)
            {
                return ItemAnswer<StageRefusal, StagedMod>.Refused(
                    StageRefusal.InstallationFileUnreadable, $"'{mod.Name}' was not staged: '{name}' cannot be read as an archive: {e.Message}");
            }
        }

        IReadOnlyList<HashedFile> files;
        try
        {
            files = _hashes.OfModFolder(mod.Folder, mod.Name);
        }
        catch (DirectoryNotFoundException)
        {
            return ItemAnswer<StageRefusal, StagedMod>.Refused(StageRefusal.ModFolderMissing, $"'{mod.Name}' was not staged: its folder does not exist.");
        }

        var manifest = new ManifestBuilder(installationFiles, path => GameFile(gameFolder, path)).Build(files);
        var written = repository.WriteManifest(mod.Folder, mod.Name, manifest);
        return ItemAnswer<StageRefusal, StagedMod>.Landed(new StagedMod(
            written, [.. manifest.Files.Where(file => file.Provider is FileProvider.NoProvider).Select(file => file.Path).Order(StringComparer.Ordinal)]));
    }

    private HashedFile? GameFile(string gameFolder, string path) =>
        repository.GameFile(gameFolder, path) is { } stamped ? _hashes.OfFile(gameFolder, stamped) : null;
}
