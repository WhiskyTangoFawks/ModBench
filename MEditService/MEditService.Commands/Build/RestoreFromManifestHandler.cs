using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>Restore from manifest (ADR-0022): every file whose bytes differ is written, and each file no line names is named
/// for the extension's trash. A mod that lacks a source is skipped whole.</summary>
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
            if (repository.ReadManifest(mod.Folder, mod.Name) is not { } held) return Skipped(mod, RestoreRefusal.NoManifest, "it has no manifest");
            manifest = held;
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

        IReadOnlyList<string> namedByNoLine;
        ModFolderFiles read;
        try
        {
            var committed = mod.CommittedFiles.ToHashSet(StringComparer.Ordinal);
            namedByNoLine = repository.NamedByNoLine(mod.Folder, mod.Name, manifest, committed);
            read = repository.Files(mod.Folder, mod.Name, committed.Union(namedByNoLine).ToHashSet(StringComparer.Ordinal), instance.StatCache);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Skipped(mod, RestoreRefusal.Unreadable, $"a file could not be read: {e.Message}");
        }

        var hashes = read.Files.ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal);
        List<ManifestSources.SourcedFile> differing = [.. resolved.Files.Where(file => hashes.GetValueOrDefault(file.Path) != file.Source.Hash)];
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
        var statCacheNotWritten = repository.KeepInStatCache(
            read, manifest, resolved.Files.ToDictionary(file => file.Path, file => file.Source.Hash, StringComparer.Ordinal));
        return ItemAnswer<RestoreSkip, RestoredMod>.Landed(new RestoredMod([.. differing.Select(file => file.Path)], namedByNoLine, statCacheNotWritten));
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
