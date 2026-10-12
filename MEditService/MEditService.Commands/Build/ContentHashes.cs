using System.Collections.Concurrent;
using System.Diagnostics;
using MEditService.ModFolderAdapter;
using MEditService.RepositoriesLib;

namespace MEditService.Commands.Build;

/// <summary>The hashes of an installation file and its entries, and of the files of a folder. A file whose
/// stamp matches the last read, and is old enough to trust, is not read again.</summary>
internal sealed class ContentHashes(IModFolderRepository repository, TimeProvider time)
{
    private readonly ConcurrentDictionary<string, StampGatedMemo<HashedFile>> _folders = new(StringComparer.Ordinal);
    private readonly StampGatedMemo<HashedInstallationFile> _installationFiles = new(time);

    public HashedInstallationFile OfInstallationFile(StampedFile file) =>
        _installationFiles.Of(file.Path, file.Stamp, () =>
        {
            using var whole = repository.OpenInstallationFile(file.Path);
            var hash = FileHash.Of(whole);
            List<HashedEntry> entries = [];
            using var archive = repository.OpenInstallationFile(file.Path);
            ArchiveExtractor.Extract(archive, (entry, size, content) =>
                entries.Add(new HashedEntry(entry, size, FileHash.Of(content))));
            return new HashedInstallationFile(whole.Length, hash, entries);
        }) ?? throw new UnreachableException();

    public IReadOnlyList<HashedFile> OfModFolder(string modFolder, string modName, IReadOnlySet<string> committed)
    {
        var files = repository.Files(modFolder, modName).Where(file => !committed.Contains(file.Path)).ToList();
        var hashed = files.Select(file => OfFile(modFolder, file)).ToList();
        MemoOf(modFolder).Retain(files.Select(file => file.Path).ToHashSet(StringComparer.Ordinal));
        return hashed;
    }

    public HashedFile OfFile(string folder, StampedFile file) =>
        MemoOf(folder).Of(file.Path, file.Stamp, () =>
        {
            var readFrom = time.GetUtcNow();
            using var content = repository.OpenFile(folder, file.Path);
            var settled = file.Stamp is { } stamp && stamp.SettledAt(readFrom) ? stamp : (FileStamp?)null;
            return new HashedFile(file.Path, content.Length, settled, FileHash.Of(content));
        }) ?? throw new UnreachableException();

    private StampGatedMemo<HashedFile> MemoOf(string folder) =>
        _folders.GetOrAdd(folder, _ => new StampGatedMemo<HashedFile>(time));
}
