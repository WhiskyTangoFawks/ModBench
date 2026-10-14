using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;

namespace MEditService.Commands.Build;

/// <summary>The Discard changes gesture: each mod's folder back to its manifest (ADR-0022). Every file the manifest
/// names whose bytes differ is written, and nothing else is touched. A mod that lacks a source is skipped whole.</summary>
public sealed class DiscardHandler(IModFolderRepository repository, INotificationPublisher notifications)
{
    public SelectionResult<string, DiscardSkip, DiscardedMod> Discard(
        IReadOnlyList<ModToDiscard> mods, InstanceToDiscard instance, CancellationToken cancel = default) =>
        ModByMod.Over(
            mods, mod => mod.Name, progress => notifications.Publish(new DiscardProgressNotification(progress)), mod => DiscardMod(mod, instance), cancel);

    private ItemAnswer<DiscardSkip, DiscardedMod> DiscardMod(ModToDiscard mod, InstanceToDiscard instance)
    {
        Manifest manifest;
        List<ManifestFile> differing;
        try
        {
            if (repository.ReadManifest(mod.Folder, mod.Name) is not { } read) return Skipped(mod, DiscardRefusal.NoManifest, "it has no manifest");
            manifest = read;
            differing = NamedFilesWithOtherBytes(mod, manifest);
        }
        catch (InvalidDataException e)
        {
            return Skipped(mod, DiscardRefusal.ManifestUnreadable, e.Message);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Skipped(mod, DiscardRefusal.Unreadable, $"a file could not be read: {e.Message}");
        }
        if (differing.Count == 0) return ItemAnswer<DiscardSkip, DiscardedMod>.Landed(new DiscardedMod([]));

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
            return Skipped(mod, DiscardRefusal.Unreadable, $"a file could not be read: {e.Message}");
        }
        if (applying.Value is not { } applied) return Lacked(mod, applying.Lacks);

        try
        {
            rebuild.Write(applied);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<DiscardSkip, DiscardedMod>.Refused(
                new DiscardSkip(DiscardRefusal.NotFinished, [], []), $"'{mod.Name}' was not finished: {e.Message.TrimEnd('.')}. Discarding it again finishes it.");
        }
        return ItemAnswer<DiscardSkip, DiscardedMod>.Landed(new DiscardedMod([.. differing.Select(file => file.Path)]));
    }

    private List<ManifestFile> NamedFilesWithOtherBytes(ModToDiscard mod, Manifest manifest)
    {
        var named = manifest.Files.Select(file => file.Path).ToHashSet(StringComparer.Ordinal);
        var untracked = repository.FilePaths(mod.Folder).Where(path => !named.Contains(path)).ToHashSet(StringComparer.Ordinal);
        var hashes = repository.Files(mod.Folder, mod.Name, untracked).ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal);
        return [.. manifest.Files.Where(file => hashes.GetValueOrDefault(file.Path) != file.Hash)];
    }

    private static ItemAnswer<DiscardSkip, DiscardedMod> Lacked(ModToDiscard mod, IReadOnlyList<ModRebuild.Lack> lacks)
    {
        var why = string.Join("; ", lacks.Select(lack => lack.Text));
        if (!lacks.All(lack => lack is ModRebuild.Lack.GameFileMissing or ModRebuild.Lack.DeltaMissing)) return Skipped(mod, DiscardRefusal.Lacking, why);
        return Skipped(mod, new DiscardSkip(
            DiscardRefusal.NotFound,
            [.. lacks.OfType<ModRebuild.Lack.GameFileMissing>().Select(lack => lack.Path)],
            [.. lacks.OfType<ModRebuild.Lack.DeltaMissing>().Select(lack => lack.Name)]), why);
    }

    private static ItemAnswer<DiscardSkip, DiscardedMod> Skipped(ModToDiscard mod, DiscardRefusal refusal, string why) =>
        Skipped(mod, new DiscardSkip(refusal, [], []), why);

    private static ItemAnswer<DiscardSkip, DiscardedMod> Skipped(ModToDiscard mod, DiscardSkip skip, string why) =>
        ItemAnswer<DiscardSkip, DiscardedMod>.Refused(skip, $"'{mod.Name}' was skipped: {why}.");
}
