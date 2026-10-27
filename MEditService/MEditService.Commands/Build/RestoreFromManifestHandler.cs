using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>Restore from manifest (ADR-0022): every file whose bytes differ is written, or the mod's submodule builds it, and
/// each file no line names is named for the extension's trash. A mod lacking anything is skipped.</summary>
public sealed class RestoreFromManifestHandler
{
    private readonly IModFolderRepository _repository;
    private readonly INotificationPublisher _notifications;
    private readonly ISourceAdapter _source;
    private readonly SourceModBuild _build;

    internal RestoreFromManifestHandler(
        IModFolderRepository repository, INotificationPublisher notifications, ISourceAdapter source, SourceModBuild build) =>
        (_repository, _notifications, _source, _build) = (repository, notifications, source, build);

    public async Task<RestoreFromManifestResult> RestoreAsync(
        IReadOnlyList<ModToRestore> mods, InstanceToRestore instance, string? gesture, CancellationToken cancel)
    {
        var restored = await ModByMod.OverAsync(
            mods, mod => mod.Name, progress => _notifications.Publish(new RestoreFromManifestProgressNotification(progress)),
            (mod, _) => RestoreModAsync(mod, instance, cancel), gesture, cancel);
        return restored.ToResult(
            landed => landed.Outcome,
            refused => new RestoreRefused(
                refused.Item, refused.Refusal.Kind, refused.Message, refused.Refusal.InstallationFilesNotFound, refused.Refusal.GameFilesNotFound,
                refused.Refusal.Build, refused.Refusal.SubmoduleNotFound),
            (applied, refused) => new RestoreFromManifestResult(applied, refused));
    }

    private async Task<ItemAnswer<RestoreSkip, ModRestored>> RestoreModAsync(ModToRestore mod, InstanceToRestore instance, CancellationToken cancel)
    {
        if (mod.Submodule is { } pinned) return await RebuildAsync(mod, instance, pinned, cancel);

        Manifest? held;
        try
        {
            if (mod.SourceFolder is null) held = _repository.ReadManifest(mod.Folder, mod.Name);
            else if (!_repository.ReadSourceManifest(mod.SourceFolder).Holds(out held, out var why)) return Skipped(RestoreRefusal.ManifestUnreadable, why);
        }
        catch (InvalidDataException e)
        {
            return Skipped(RestoreRefusal.ManifestUnreadable, e.Message);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Skipped(RestoreRefusal.Unreadable, $"a file could not be read: {e.Message}");
        }

        if (held is not { } manifest) return Skipped(RestoreRefusal.NoManifest, "it has no manifest");
        var resolved = new PackageContents(_repository, manifest, mod.InstallationFiles, instance.GameFolder, mod.UnreadableGameFiles, mod.UnreadableInstallationFiles).Resolve();
        List<PackageContents.Lack> lacks = [.. resolved.Lacks];
        if (ToolsWithoutTask.Why(manifest, instance.Tasks) is { } noTask) lacks.Add(new PackageContents.Lack.NoTask(noTask));
        if (lacks.Count > 0) return Lacked(lacks);
        if (resolved.Built is { } submodule) return Lacked([new PackageContents.Lack.SubmoduleMissing(submodule)]);

        IReadOnlyList<string> namedByNoLine;
        ModFolderFiles read;
        try
        {
            var metadataFiles = mod.MetadataFiles.ToHashSet(StringComparer.Ordinal);
            namedByNoLine = _repository.NamedByNoLine(mod.Folder, mod.Name, manifest, metadataFiles);
            read = _repository.Files(mod.Folder, mod.Name, metadataFiles.Union(namedByNoLine).ToHashSet(StringComparer.Ordinal), instance.StatCache);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return Skipped(RestoreRefusal.Unreadable, $"a file could not be read: {e.Message}");
        }

        var hashes = read.Files.ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal);
        List<PackageContents.PackagedFile> differing = [.. resolved.Files.Where(file => hashes.GetValueOrDefault(file.Path) != file.Hash)];
        try
        {
            new ModRebuild(_repository, mod.Folder).Write(differing);
        }
        catch (InvalidDataException e)
        {
            return ItemAnswer<RestoreSkip, ModRestored>.Refused(
                new RestoreSkip(RestoreRefusal.NotFinished), $"was not finished: {e.Message.TrimEnd('.')}.");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ItemAnswer<RestoreSkip, ModRestored>.Refused(
                new RestoreSkip(RestoreRefusal.NotFinished), $"was not finished: {e.Message.TrimEnd('.')}. Restoring it again finishes it.");
        }
        var statCacheNotWritten = _repository.KeepInStatCache(
            read, manifest, resolved.Files.ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal));
        return ItemAnswer<RestoreSkip, ModRestored>.Landed(new ModRestored(
            mod.Name, [.. differing.Select(file => file.Path)], namedByNoLine, statCacheNotWritten, ModMetadata.Of(manifest), manifest.Steps));
    }

    // modlist-repository.md, Restore from manifest, stories 3 and 5: what the build makes comes back as the build makes it,
    // and only at the commit the instance repository pins.
    private async Task<ItemAnswer<RestoreSkip, ModRestored>> RebuildAsync(
        ModToRestore mod, InstanceToRestore instance, Submodule submodule, CancellationToken cancel)
    {
        if (!_source.CommitAtHead(submodule, cancel).Holds(out var checkedOut, out var failure))
            return Skipped(RestoreRefusal.SourceUnavailable, $"its submodule could not be cloned or read: {failure.Reason.TrimEnd('.')}");
        if (checkedOut.Commit != submodule.Pin)
            return Skipped(RestoreRefusal.SourceAtAnotherCommit, $"its submodule is at {checkedOut.Commit}, not at {submodule.Pin}, the commit the instance repository pins");
        var version = VersionIn(submodule.Folder);

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

        var answer = await _build.BuildAsync(
            new ModToBuild(mod.Name, submodule.Folder, mod.Folder, mod.MetadataFiles, version, IsSubmodule: true)
            {
                InstallationFiles = mod.InstallationFiles,
                UnreadableInstallationFiles = mod.UnreadableInstallationFiles,
            },
            new InstanceToBuild(instance.ExclusionMark, instance.Archives, instance.StatCache) { Tasks = instance.Tasks });
        if (answer is ItemAnswer<BuildStop, ModBuildOutcome>.Refusing refusing)
            return ItemAnswer<RestoreSkip, ModRestored>.Refused(Skip(refusing.Refusal), refusing.Message);
        var outcome = ((ItemAnswer<BuildStop, ModBuildOutcome>.Wrote)answer).Outcome;
        List<string> leftAsItWas = [.. outcome.Refused.Select(plugin => plugin.Message), .. outcome.ArchivesRefused.Select(archive => archive.Message)];
        if (outcome.Failure is { } stopped) leftAsItWas.Insert(0, stopped);
        if (leftAsItWas.Count > 0)
        {
            return ItemAnswer<RestoreSkip, ModRestored>.Refused(
                new RestoreSkip(RestoreRefusal.NotFinished),
                $"was not finished: {string.Join("; ", leftAsItWas.Select(why => why.TrimEnd('.')))}.");
        }

        try
        {
            var after = HashesIn(mod, metadataFiles, instance);
            var manifest = outcome.Manifest ?? throw new InvalidOperationException("A build that stopped nowhere recorded its manifest.");
            return ItemAnswer<RestoreSkip, ModRestored>.Landed(new ModRestored(
                mod.Name,
                [.. after.Where(file => before.GetValueOrDefault(file.Key) != file.Value).Select(file => file.Key).Order(StringComparer.Ordinal)],
                _repository.NamedByNoLine(mod.Folder, mod.Name, manifest, metadataFiles), StatCacheNotWritten: null, ModMetadata.Of(manifest), outcome.Steps,
                outcome.Uncommitted, checkedOut.LeftDetached));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            return ItemAnswer<RestoreSkip, ModRestored>.Refused(
                new RestoreSkip(RestoreRefusal.NotFinished), $"was not finished: {e.Message.TrimEnd('.')}. Restoring it again finishes it.");
        }
    }

    // A manifest that cannot be read refuses the build that follows, naming why.
    private string? VersionIn(string sourceFolder) =>
        _repository.ReadSourceManifest(sourceFolder).Holds(out var manifest, out _) ? manifest?.Version : null;

    private Dictionary<string, string> HashesIn(ModToRestore mod, IReadOnlySet<string> metadataFiles, InstanceToRestore instance) =>
        _repository.Files(mod.Folder, mod.Name, metadataFiles, instance.StatCache).Files.ToDictionary(file => file.Path, file => file.Hash, StringComparer.Ordinal);

    private static ItemAnswer<RestoreSkip, ModRestored> Lacked(IReadOnlyList<PackageContents.Lack> lacks)
    {
        var why = string.Join("; ", lacks.Select(lack => lack.Text));
        if (lacks.Any(lack => lack is PackageContents.Lack.NoHost)) return Skipped(RestoreRefusal.NoHost, why);
        var gameFiles = lacks.OfType<PackageContents.Lack.GameFileMissing>().Select(lack => lack.Path).ToList();
        var installationFiles = lacks.OfType<PackageContents.Lack.InstallationFileMissing>().Select(lack => lack.Named).ToList();
        var submodule = lacks.OfType<PackageContents.Lack.SubmoduleMissing>().Select(lack => lack.Name).FirstOrDefault();
        if (gameFiles.Count == 0 && installationFiles.Count == 0 && submodule is null)
            return Skipped(lacks.All(lack => lack is PackageContents.Lack.NoTask) ? RestoreRefusal.NoTaskForTool : RestoreRefusal.Lacking, why);
        return Skipped(
            new RestoreSkip(RestoreRefusal.NotFound) { InstallationFilesNotFound = installationFiles, GameFilesNotFound = gameFiles, SubmoduleNotFound = submodule },
            why);
    }

    private static RestoreSkip Skip(BuildStop stop) => stop.InstallationFilesNotFound.Count > 0
        ? new RestoreSkip(RestoreRefusal.NotFound, stop.Kind) { InstallationFilesNotFound = stop.InstallationFilesNotFound }
        : new RestoreSkip(RestoreRefusal.NotBuilt, stop.Kind);

    private static ItemAnswer<RestoreSkip, ModRestored> Skipped(RestoreRefusal refusal, string why) =>
        Skipped(new RestoreSkip(refusal), why);

    private static ItemAnswer<RestoreSkip, ModRestored> Skipped(RestoreSkip skip, string why) =>
        ItemAnswer<RestoreSkip, ModRestored>.Refused(skip, $"was skipped: {why}.");
}
