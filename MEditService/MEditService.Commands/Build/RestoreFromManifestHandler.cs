using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>Restore from manifest: each mod's folder back to its manifest (ADR-0022). Every file the manifest names whose
/// bytes differ is written, and nothing else is touched. A mod that lacks a source is skipped whole.</summary>
public sealed class RestoreFromManifestHandler(IModFolderRepository repository, INotificationPublisher notifications)
{
    public SelectionResult<string, RestoreSkip, RestoredMod> Restore(
        IReadOnlyList<ModToRestore> mods, InstanceToRestore instance, string? gesture = null, CancellationToken cancel = default) =>
        ModByMod.Over(
            mods, mod => mod.Name, progress => notifications.Publish(new RestoreFromManifestProgressNotification(progress)),
            mod => RestoreMod(mod, instance), gesture, cancel);

    private ItemAnswer<RestoreSkip, RestoredMod> RestoreMod(ModToRestore mod, InstanceToRestore instance)
    {
        Manifest manifest;
        try
        {
            if (repository.ReadManifest(mod.Folder, mod.Name) is not { } read) return Skipped(mod, RestoreRefusal.NoManifest, "it has no manifest");
            manifest = read;
        }
        catch (InvalidDataException e)
        {
            return Skipped(mod, RestoreRefusal.ManifestUnreadable, e.Message);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Skipped(mod, RestoreRefusal.Unreadable, $"a file could not be read: {e.Message}");
        }

        var resolved = new ManifestSources(repository, manifest, mod.InstallationFiles, instance.GameFiles).Resolve();
        if (resolved.Lacks.Count > 0) return Lacked(mod, resolved.Lacks);

        List<ManifestSources.SourcedFile> differing;
        try
        {
            differing = WithOtherBytes(mod, resolved);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Skipped(mod, RestoreRefusal.Unreadable, $"a file could not be read: {e.Message}");
        }

        try
        {
            new ModRebuild(repository, mod.Folder, instance.DataFolder).Write(differing);
        }
        catch (InvalidDataException e)
        {
            return ItemAnswer<RestoreSkip, RestoredMod>.Refused(
                new RestoreSkip(RestoreRefusal.NotFinished, []), $"'{mod.Name}' was not finished: {e.Message.TrimEnd('.')}.");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<RestoreSkip, RestoredMod>.Refused(
                new RestoreSkip(RestoreRefusal.NotFinished, []), $"'{mod.Name}' was not finished: {e.Message.TrimEnd('.')}. Restoring it again finishes it.");
        }
        return ItemAnswer<RestoreSkip, RestoredMod>.Landed(new RestoredMod([.. differing.Select(file => file.Path)]));
    }

    private List<ManifestSources.SourcedFile> WithOtherBytes(ModToRestore mod, ManifestSources.Resolved resolved)
    {
        var provided = resolved.Hashes();
        var untracked = repository.FilePaths(mod.Folder).Where(path => !provided.ContainsKey(path)).ToHashSet(StringComparer.Ordinal);
        var hashes = repository.Files(mod.Folder, mod.Name, untracked, provided).ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal);
        return [.. resolved.Files.Where(file => hashes.GetValueOrDefault(file.Path) != file.Source.Hash)];
    }

    private static ItemAnswer<RestoreSkip, RestoredMod> Lacked(ModToRestore mod, IReadOnlyList<ManifestSources.Lack> lacks)
    {
        var why = string.Join("; ", lacks.Select(lack => lack.Text));
        if (!lacks.All(lack => lack is ManifestSources.Lack.GameFileMissing)) return Skipped(mod, RestoreRefusal.Lacking, why);
        return Skipped(mod, new RestoreSkip(RestoreRefusal.NotFound, [.. lacks.OfType<ManifestSources.Lack.GameFileMissing>().Select(lack => lack.Path)]), why);
    }

    private static ItemAnswer<RestoreSkip, RestoredMod> Skipped(ModToRestore mod, RestoreRefusal refusal, string why) =>
        Skipped(mod, new RestoreSkip(refusal, []), why);

    private static ItemAnswer<RestoreSkip, RestoredMod> Skipped(ModToRestore mod, RestoreSkip skip, string why) =>
        ItemAnswer<RestoreSkip, RestoredMod>.Refused(skip, $"'{mod.Name}' was skipped: {why}.");
}
