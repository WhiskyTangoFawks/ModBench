using System.Text;
using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

public sealed class ModFolderRepository(TimeProvider time) : IModFolderRepository
{
    private const string ManifestExtension = ".manifest";

    public IReadOnlyList<HashedFile> Files(string modFolder, string modName, IReadOnlySet<string> leftOut)
    {
        var files = new DirectoryInfo(modFolder).EnumerateFiles("*", SearchOption.AllDirectories)
            .Select(file => (Path: Path.GetRelativePath(modFolder, file.FullName).Replace('\\', '/'), Size: file.Length))
            .Where(file => file.Path != ManifestName(modName) && !leftOut.Contains(file.Path))
            .ToList();
        var manifest = Path.Combine(modFolder, ManifestName(modName));
        var lines = File.Exists(manifest) ? ManifestText.LineStamps(File.ReadAllText(manifest, Encoding.UTF8)) : [];
        return [.. files.Select(file => Hashed(modFolder, file.Path, file.Size, lines.TryGetValue(file.Path, out var line) ? line : null))];
    }

    public Stream OpenFile(string modFolder, string path) => File.OpenRead(Path.Combine(modFolder, path));

    public bool InstallationFileExists(string path) => File.Exists(path);

    public string InstallationFileName(string path) => Path.GetFileName(path);

    public Stream OpenInstallationFile(string path) => File.OpenRead(path);

    public Stream OpenGameFile(string dataFolder, string path) => File.OpenRead(Path.Combine(dataFolder, path));

    public bool WriteManifest(string modFolder, string modName, Manifest manifest)
    {
        var path = Path.Combine(modFolder, ManifestName(modName));
        var text = ManifestText.Of(manifest);
        if (File.Exists(path) && File.ReadAllText(path, Encoding.UTF8) == text) return false;

        File.WriteAllText(path, text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return true;
    }

    public long? DeltaSize(string buildFolder, string path, string baseHash, string fileHash)
    {
        var delta = new FileInfo(Path.Combine(buildFolder, ManifestText.DeltaName(path, baseHash, fileHash)));
        return delta.Exists ? delta.Length : null;
    }

    public void WriteDelta(string buildFolder, string path, string baseHash, string fileHash, byte[] delta)
    {
        Directory.CreateDirectory(buildFolder);
        var named = Path.Combine(buildFolder, ManifestText.DeltaName(path, baseHash, fileHash));
        var partial = named + ".partial";
        File.WriteAllBytes(partial, delta);
        File.Move(partial, named, overwrite: true);
    }

    private HashedFile Hashed(string modFolder, string path, long size, LineStamp? line)
    {
        var stamp = FileStamp.Of(Path.Combine(modFolder, path));
        if (stamp is { } now && line is { } known && known.Size == now.Size && known.Modified == now.Modified)
            return new HashedFile(path, size, known.Hash, now);

        var readFrom = time.GetUtcNow();
        using var content = new FileStream(Path.Combine(modFolder, path), FileMode.Open, FileAccess.Read, FileShare.Read);
        return new HashedFile(path, size, FileHash.Of(content), stamp is { } read && read.SettledAt(readFrom) ? read : null);
    }

    private static string ManifestName(string modName) => modName + ManifestExtension;
}
