using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>Restore from manifest: each mod's folder back to its manifest (ADR-0022). Every file the manifest names whose
/// bytes differ is written, and nothing else is touched. A mod that lacks a source is skipped whole.</summary>
public sealed class RestoreFromManifestHandler(IModFolderRepository repository, INotificationPublisher notifications)
{
    public SelectionResult<string, RestoreSkip, RestoredMod> Restore(
        IReadOnlyList<ModToRestore> mods, InstanceToRestore instance, CancellationToken cancel = default) =>
        ModByMod.Over(
            mods, mod => mod.Name, progress => notifications.Publish(new RestoreFromManifestProgressNotification(progress)), mod => RestoreMod(mod, instance), cancel);

    private ItemAnswer<RestoreSkip, RestoredMod> RestoreMod(ModToRestore mod, InstanceToRestore instance)
    {
        Manifest manifest;
        List<ManifestFile> differing;
        try
        {
            if (repository.ReadManifest(mod.Folder, mod.Name) is not { } read) return Skipped(mod, RestoreRefusal.NoManifest, "it has no manifest");
            manifest = read;
            differing = NamedFilesWithOtherBytes(mod, manifest);
        }
        catch (InvalidDataException e)
        {
            return Skipped(mod, RestoreRefusal.ManifestUnreadable, e.Message);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Skipped(mod, RestoreRefusal.Unreadable, $"a file could not be read: {e.Message}");
        }
        if (differing.Count == 0) return ItemAnswer<RestoreSkip, RestoredMod>.Landed(new RestoredMod([]));

        using var rebuild = new ModRebuild(repository, mod, instance, manifest);
        var resolved = rebuild.Resolve(differing);
        if (resolved.Value is not { } sourced) return Lacked(mod, resolved.Lacks);

        ModRebuild.Step<ModRebuild.Applied> applying;
        try
        {
            applying = rebuild.ApplyDeltas(sourced);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Skipped(mod, RestoreRefusal.Unreadable, $"a file could not be read: {e.Message}");
        }
        if (applying.Value is not { } applied) return Lacked(mod, applying.Lacks);

        try
        {
            rebuild.Write(applied);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<RestoreSkip, RestoredMod>.Refused(
                new RestoreSkip(RestoreRefusal.NotFinished, [], []), $"'{mod.Name}' was not finished: {e.Message.TrimEnd('.')}. Restoring it again finishes it.");
        }
        return ItemAnswer<RestoreSkip, RestoredMod>.Landed(new RestoredMod([.. differing.Select(file => file.Path)]));
    }

    private List<ManifestFile> NamedFilesWithOtherBytes(ModToRestore mod, Manifest manifest)
    {
        var named = manifest.Files.Select(file => file.Path).ToHashSet(StringComparer.Ordinal);
        var untracked = repository.FilePaths(mod.Folder).Where(path => !named.Contains(path)).ToHashSet(StringComparer.Ordinal);
        var hashes = repository.Files(mod.Folder, mod.Name, untracked).ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal);
        return [.. manifest.Files.Where(file => hashes.GetValueOrDefault(file.Path) != file.Hash)];
    }

    private static ItemAnswer<RestoreSkip, RestoredMod> Lacked(ModToRestore mod, IReadOnlyList<ModRebuild.Lack> lacks)
    {
        var why = string.Join("; ", lacks.Select(lack => lack.Text));
        if (!lacks.All(lack => lack is ModRebuild.Lack.GameFileMissing or ModRebuild.Lack.DeltaMissing)) return Skipped(mod, RestoreRefusal.Lacking, why);
        return Skipped(mod, new RestoreSkip(
            RestoreRefusal.NotFound,
            [.. lacks.OfType<ModRebuild.Lack.GameFileMissing>().Select(lack => lack.Path)],
            [.. lacks.OfType<ModRebuild.Lack.DeltaMissing>().Select(lack => lack.Name)]), why);
    }

    private static ItemAnswer<RestoreSkip, RestoredMod> Skipped(ModToRestore mod, RestoreRefusal refusal, string why) =>
        Skipped(mod, new RestoreSkip(refusal, [], []), why);

    private static ItemAnswer<RestoreSkip, RestoredMod> Skipped(ModToRestore mod, RestoreSkip skip, string why) =>
        ItemAnswer<RestoreSkip, RestoredMod>.Refused(skip, $"'{mod.Name}' was skipped: {why}.");
}
