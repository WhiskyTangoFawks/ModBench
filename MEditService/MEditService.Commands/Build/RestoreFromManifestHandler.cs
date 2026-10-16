using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>Restore from manifest (ADR-0022): every file whose bytes differ is written, or the mod's source builds it, and
/// each file no line names is named for the extension's trash. A mod lacking anything is skipped.</summary>
public sealed class RestoreFromManifestHandler(
    IModFolderRepository repository, INotificationPublisher notifications, ISourceAdapter source, BuildHandler build)
{
    public Task<SelectionResult<string, RestoreSkip, RestoredMod>> RestoreAsync(
        IReadOnlyList<ModToRestore> mods, InstanceToRestore instance, string? gesture = null, CancellationToken cancel = default) =>
        ModByMod.OverAsync(
            mods, mod => mod.Name, progress => notifications.Publish(new RestoreFromManifestProgressNotification(progress)),
            mod => RestoreModAsync(mod, instance, cancel), gesture, cancel);

    private async Task<ItemAnswer<RestoreSkip, RestoredMod>> RestoreModAsync(ModToRestore mod, InstanceToRestore instance, CancellationToken cancel)
    {
        Manifest manifest;
        try
        {
            if (repository.ReadManifest(mod.Folder, mod.Name) is not { } held) return Skipped(RestoreRefusal.NoManifest, "it has no manifest");
            manifest = held;
        }
        catch (InvalidDataException e)
        {
            return Skipped(RestoreRefusal.ManifestUnreadable, e.Message);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Skipped(RestoreRefusal.Unreadable, $"a file could not be read: {e.Message}");
        }

        var resolved = new ManifestSources(repository, manifest, mod.InstallationFiles, instance.GameFiles).Resolve();
        if (resolved.Lacks.Count > 0) return Lacked(resolved.Lacks);
        if (resolved.Built is { } built) return await RebuildAsync(mod, instance, built, resolved.InstallationFiles, manifest.Version, cancel);

        IReadOnlyList<string> namedByNoLine;
        ModFolderFiles read;
        try
        {
            var metadataFiles = mod.MetadataFiles.ToHashSet(StringComparer.Ordinal);
            namedByNoLine = repository.NamedByNoLine(mod.Folder, mod.Name, manifest, metadataFiles);
            read = repository.Files(mod.Folder, mod.Name, metadataFiles.Union(namedByNoLine).ToHashSet(StringComparer.Ordinal), instance.StatCache);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Skipped(RestoreRefusal.Unreadable, $"a file could not be read: {e.Message}");
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
                new RestoreSkip(RestoreRefusal.NotFinished), $"was not finished: {e.Message.TrimEnd('.')}.");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<RestoreSkip, RestoredMod>.Refused(
                new RestoreSkip(RestoreRefusal.NotFinished), $"was not finished: {e.Message.TrimEnd('.')}. Restoring it again finishes it.");
        }
        var statCacheNotWritten = repository.KeepInStatCache(
            read, manifest, resolved.Files.ToDictionary(file => file.Path, file => file.Source.Hash, StringComparer.Ordinal));
        return ItemAnswer<RestoreSkip, RestoredMod>.Landed(new RestoredMod([.. differing.Select(file => file.Path)], namedByNoLine, statCacheNotWritten, ModMetadata.Of(manifest)));
    }

    // modlist-repository.md, Restore from manifest, stories 3 and 5: what the build makes comes back as the build makes it,
    // and only at the commit the manifest names.
    private async Task<ItemAnswer<RestoreSkip, RestoredMod>> RebuildAsync(
        ModToRestore mod, InstanceToRestore instance, SharedSource built, IReadOnlyList<InstallationFile> installationFiles, string? version,
        CancellationToken cancel)
    {
        if (mod.SourceFolder is not { } sourceFolder) return Skipped(RestoreRefusal.SourceUnavailable, "its name gives it no source folder");
        if (!source.CommitAtHead(sourceFolder, built, cancel).Holds(out var head, out var failure))
            return Skipped(RestoreRefusal.SourceUnavailable, $"its source could not be cloned or read: {failure.Reason.TrimEnd('.')}");
        if (head != built.Commit)
            return Skipped(RestoreRefusal.SourceAtAnotherCommit, $"its source is at {head}, not at {built.Commit}, the commit its manifest names");

        var metadataFiles = mod.MetadataFiles.ToHashSet(StringComparer.Ordinal);
        Dictionary<string, string> before;
        try
        {
            before = HashesIn(mod, metadataFiles, instance);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Skipped(RestoreRefusal.Unreadable, $"a file could not be read: {e.Message}");
        }

        var answer = await build.BuildOneAsync(
            new ModToBuild(mod.Name, sourceFolder, mod.Folder, installationFiles, mod.MetadataFiles, version),
            new InstanceToBuild(instance.ExcludedSuffix, instance.Archives, instance.StatCache));
        if (answer is ItemAnswer<BuildRefusal, BuiltMod>.Refusing refusing)
            return ItemAnswer<RestoreSkip, RestoredMod>.Refused(new RestoreSkip(RestoreRefusal.NotBuilt, refusing.Refusal), refusing.Message);
        var outcome = ((ItemAnswer<BuildRefusal, BuiltMod>.Wrote)answer).Outcome;
        List<string> leftAsItWas = [.. outcome.Refused.Select(plugin => plugin.Message), .. outcome.ArchivesRefused.Select(archive => archive.Message)];
        if (outcome.Failure is { } stopped) leftAsItWas.Insert(0, stopped);
        if (leftAsItWas.Count > 0)
        {
            return ItemAnswer<RestoreSkip, RestoredMod>.Refused(
                new RestoreSkip(RestoreRefusal.NotFinished),
                $"was not finished: {string.Join("; ", leftAsItWas.Select(why => why.TrimEnd('.')))}.");
        }

        try
        {
            var after = HashesIn(mod, metadataFiles, instance);
            var manifest = outcome.Manifest ?? throw new InvalidOperationException("A build that stopped nowhere wrote its manifest.");
            return ItemAnswer<RestoreSkip, RestoredMod>.Landed(new RestoredMod(
                [.. after.Where(file => before.GetValueOrDefault(file.Key) != file.Value).Select(file => file.Key).Order(StringComparer.Ordinal)],
                repository.NamedByNoLine(mod.Folder, mod.Name, manifest, metadataFiles), StatCacheNotWritten: null, ModMetadata.Of(manifest), outcome.Uncommitted));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            return ItemAnswer<RestoreSkip, RestoredMod>.Refused(
                new RestoreSkip(RestoreRefusal.NotFinished), $"was not finished: {e.Message.TrimEnd('.')}. Restoring it again finishes it.");
        }
    }

    private Dictionary<string, string> HashesIn(ModToRestore mod, IReadOnlySet<string> metadataFiles, InstanceToRestore instance) =>
        repository.Files(mod.Folder, mod.Name, metadataFiles, instance.StatCache).Files.ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal);

    private static ItemAnswer<RestoreSkip, RestoredMod> Lacked(IReadOnlyList<ManifestSources.Lack> lacks)
    {
        var why = string.Join("; ", lacks.Select(lack => lack.Text));
        if (!lacks.Any(lack => lack is ManifestSources.Lack.NotHanded)) return Skipped(RestoreRefusal.Lacking, why);
        return Skipped(new RestoreSkip(RestoreRefusal.NotFound)
        {
            GameFilesNotFound = [.. lacks.OfType<ManifestSources.Lack.GameFileMissing>().Select(lack => lack.Path)],
            InstallationFilesNotFound = [.. lacks.OfType<ManifestSources.Lack.InstallationFileMissing>().Select(lack => lack.Name)],
        }, why);
    }

    private static ItemAnswer<RestoreSkip, RestoredMod> Skipped(RestoreRefusal refusal, string why) =>
        Skipped(new RestoreSkip(refusal), why);

    private static ItemAnswer<RestoreSkip, RestoredMod> Skipped(RestoreSkip skip, string why) =>
        ItemAnswer<RestoreSkip, RestoredMod>.Refused(skip, $"was skipped: {why}.");
}
