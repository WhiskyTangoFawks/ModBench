using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>Writes a mod folder's files from its installation file, read once, or from the game folder.</summary>
internal sealed class ModRebuild(IModFolderRepository repository, string modFolder)
{
    /// <summary>A write that fails leaves the files before it written. Throws <see cref="InvalidDataException"/> for an
    /// installation file that is not an archive it can read.</summary>
    public void Write(IReadOnlyList<PackageContents.PackagedFile> files)
    {
        foreach (var game in files.OfType<PackageContents.PackagedFile.InGameFolder>())
        {
            repository.WriteFile(modFolder, game.Path, target =>
            {
                using var taken = repository.OpenGameFile(game.Root, game.GamePath);
                taken.CopyTo(target);
            });
        }
        foreach (var fromOne in files.OfType<PackageContents.PackagedFile.InInstallationFile>().GroupBy(file => file.File))
        {
            var wanted = fromOne.ToLookup(file => file.EntryPath, file => file.Path, StringComparer.OrdinalIgnoreCase);
            Extract(fromOne.Key, wanted.Select(group => group.Key), (entry, content) =>
            {
                var first = wanted[entry].First();
                repository.WriteFile(modFolder, first, content.CopyTo);
                foreach (var path in wanted[entry].Skip(1))
                {
                    repository.WriteFile(modFolder, path, target =>
                    {
                        using var copy = repository.OpenFile(modFolder, first);
                        copy.CopyTo(target);
                    });
                }
            });
        }
    }

    internal void Extract(InstallationFile file, IEnumerable<string> entries, Action<string, Stream> onEntry)
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
            throw new InvalidDataException(
                $"'{repository.InstallationFileName(file.Path)}' is not an archive restore from manifest can read: {e.Message}", e);
        }
    }
}
