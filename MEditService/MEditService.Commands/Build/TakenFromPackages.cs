using MEditService.Commands.Edits;
using MEditService.ModFolderAdapter;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>The files a source mod's manifest takes from the installation files and the game folder it names, read as assets
/// (modlist-repository.md, The manifest, stories 7 and 15).</summary>
internal sealed class TakenFromPackages(IModFolderRepository repository) : IDisposable
{
    private readonly IScratchFiles _scratch = repository.CreateScratchFiles();
    private IReadOnlyList<PackageContents.PackagedFile> _taken = [];

    /// <summary>Null when every package the manifest names is handed with the bytes it pins and holds each file a line takes;
    /// otherwise the build's refusal, naming the installation files and game files the request has not handed.</summary>
    public ItemAnswer<BuildStop, ModBuildOutcome>? Lacking(Manifest manifest, ModToBuild mod, GameFolder? gameFolder)
    {
        var resolved = new PackageContents(repository, manifest, mod.InstallationFiles, gameFolder, mod.UnreadableGameFiles, mod.UnreadableInstallationFiles).Resolve();
        _taken = resolved.Files;
        var lacks = resolved.Lacks;
        if (lacks.Count == 0) return null;
        return ItemAnswer<BuildStop, ModBuildOutcome>.Refused(
            new BuildStop(BuildRefusal.PackageLacking)
            {
                InstallationFilesNotFound = [.. lacks.OfType<PackageContents.Lack.InstallationFileMissing>().Select(lack => lack.Named)],
                GameFilesNotFound = [.. lacks.OfType<PackageContents.Lack.GameFileMissing>().Select(lack => lack.Path)],
            },
            $"was not built: {string.Join("; ", lacks.Select(lack => lack.Text))}.");
    }

    /// <summary>Each taken file as an asset, read from a temporary file this removes once the build is done, or from the game.</summary>
    public IEnumerable<Asset> Extract()
    {
        List<Asset> extracted =
            [.. _taken.OfType<PackageContents.PackagedFile.InGameFolder>().Select(game => new Asset(game.Path, () => repository.OpenGameFile(game.Root, game.GamePath)))];
        foreach (var fromOne in _taken.OfType<PackageContents.PackagedFile.InInstallationFile>().GroupBy(taken => taken.File))
        {
            var wanted = fromOne.ToLookup(taken => taken.EntryPath, taken => taken.Path, StringComparer.OrdinalIgnoreCase);
            Extract(fromOne.Key, wanted.Select(group => group.Key), (entry, content) =>
            {
                var stored = _scratch.Store(content);
                foreach (var path in wanted[entry]) extracted.Add(new Asset(path, stored));
            });
        }
        return extracted;
    }

    private void Extract(InstallationFile file, IEnumerable<string> entries, Action<string, Stream> onEntry)
    {
        var wanted = entries.ToHashSet(StringComparer.OrdinalIgnoreCase);
        using var archive = repository.OpenInstallationFile(file.Path);
        try
        {
            ArchiveExtractor.Extract(archive, (entry, content) =>
            {
                if (wanted.TryGetValue(entry, out var asNamed)) onEntry(asNamed, content);
            });
        }
        catch (SharpCompress.Common.SharpCompressException e)
        {
            throw new InvalidDataException($"'{repository.InstallationFileName(file.Path)}' is not an archive a build can read: {e.Message}", e);
        }
    }

    public void Dispose() => _scratch.Dispose();
}
