using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>Writes a mod folder's files from their sources, each installation file read once.</summary>
internal sealed class ModRebuild(IModFolderRepository repository, string modFolder, string dataFolder)
{
    /// <summary>A write that fails leaves the files before it written.</summary>
    public void Write(IReadOnlyList<(ManifestFile File, ManifestSources.Source Source)> files)
    {
        List<(string Path, ManifestSources.EntrySource Entry)> fromEntries = [];
        foreach (var (file, source) in files)
        {
            switch (source)
            {
                case ManifestSources.GameSource game:
                    repository.WriteFile(modFolder, file.Path, target =>
                    {
                        using var copy = repository.OpenGameFile(dataFolder, game.File.Path);
                        copy.CopyTo(target);
                    });
                    break;
                case ManifestSources.EntrySource entry:
                    fromEntries.Add((file.Path, entry));
                    break;
            }
        }
        foreach (var fromOne in fromEntries.GroupBy(file => file.Entry.File))
        {
            var wanted = fromOne.ToLookup(file => file.Entry.Path, file => file.Path, StringComparer.OrdinalIgnoreCase);
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
            throw new IOException($"'{repository.InstallationFileName(file.Path)}' is not an archive restore from manifest can read: {e.Message}", e);
        }
    }
}
