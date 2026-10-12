using System.Collections.Concurrent;
using MEditService.ModFolderAdapter;
using MEditService.RepositoriesLib;

namespace MEditService.Commands.Engine;

/// <summary>The hashes of an installation file's entries and of a mod folder's files. A file whose stamp matches
/// the last run is not read again.</summary>
public sealed class ContentHashes(IModFolderRepository repository)
{
    private readonly ConcurrentDictionary<(string ModFolder, string Path), (FileStamp Stamp, FileHash Hash)> _folderFiles = new();
    private readonly ConcurrentDictionary<string, (FileStamp Stamp, IReadOnlyList<HashedEntry> Entries)> _installationFiles = new();

    public IReadOnlyList<HashedEntry> OfInstallationFile(string path)
    {
        var stamp = repository.InstallationFile(path).Stamp;
        if (stamp is { } now && _installationFiles.TryGetValue(path, out var known) && known.Stamp == now)
            return known.Entries;

        List<HashedEntry> entries = [];
        using (var archive = repository.OpenInstallationFile(path))
        {
            ArchiveExtractor.Extract(archive, (entry, size, content) =>
                entries.Add(new HashedEntry(entry, size, FileHash.Of(content))));
        }
        if (stamp is { } taken) _installationFiles[path] = (taken, entries);
        return entries;
    }

    public IReadOnlyDictionary<string, FileHash> OfModFolder(string modFolder) =>
        repository.Files(modFolder).ToDictionary(file => file.Path, file => HashOf(modFolder, file));

    private FileHash HashOf(string modFolder, ModFile file)
    {
        var key = (modFolder, file.Path);
        if (file.Stamp is { } now && _folderFiles.TryGetValue(key, out var known) && known.Stamp == now)
            return known.Hash;

        using var content = repository.OpenFile(modFolder, file.Path);
        var hash = FileHash.Of(content);
        if (file.Stamp is { } taken) _folderFiles[key] = (taken, hash);
        return hash;
    }
}
