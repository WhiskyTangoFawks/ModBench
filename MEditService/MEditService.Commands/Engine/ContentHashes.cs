using System.Collections.Concurrent;
using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Engine;

/// <summary>The hashes of an installation file's entries and of a mod folder's files. A file whose size and
/// modified time match the last run is not read again.</summary>
public sealed class ContentHashes(IModFolderRepository repository)
{
    private readonly ConcurrentDictionary<string, (ModFile Stamp, FileHash Hash)> _folderFiles = new();
    private readonly ConcurrentDictionary<string, (ModFile Stamp, IReadOnlyList<HashedEntry> Entries)> _installationFiles = new();

    public IReadOnlyList<HashedEntry> OfInstallationFile(string path)
    {
        var stamp = repository.InstallationFile(path);
        if (_installationFiles.TryGetValue(path, out var known) && known.Stamp == stamp) return known.Entries;

        List<HashedEntry> entries = [];
        using (var archive = repository.OpenInstallationFile(path))
        {
            ArchiveExtractor.Extract(archive, (entry, size, content) =>
                entries.Add(new HashedEntry(entry, size, FileHash.Of(content))));
        }
        _installationFiles[path] = (stamp, entries);
        return entries;
    }

    public IReadOnlyDictionary<string, FileHash> OfModFolder(string modFolder) =>
        repository.Files(modFolder).ToDictionary(file => file.Path, file => HashOf(modFolder, file));

    private FileHash HashOf(string modFolder, ModFile file)
    {
        var key = Path.Combine(modFolder, file.Path);
        if (_folderFiles.TryGetValue(key, out var known) && known.Stamp == file) return known.Hash;

        using var content = repository.OpenFile(modFolder, file.Path);
        var hash = FileHash.Of(content);
        _folderFiles[key] = (file, hash);
        return hash;
    }
}
