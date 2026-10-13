using System.Text;
using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

public sealed class ModFolderRepository(TimeProvider time) : IModFolderRepository
{
    private const string ManifestExtension = ".manifest";

    public IReadOnlyList<HashedFile> Files(string modFolder, string modName, IReadOnlySet<string> leftOut)
    {
        var paths = new DirectoryInfo(modFolder).EnumerateFiles("*", SearchOption.AllDirectories)
            .Select(file => Path.GetRelativePath(modFolder, file.FullName).Replace('\\', '/'))
            .Where(path => path != ManifestName(modName) && !leftOut.Contains(path))
            .ToList();
        var manifest = Path.Combine(modFolder, ManifestName(modName));
        var lines = File.Exists(manifest) ? ManifestText.LineStamps(File.ReadAllText(manifest, Encoding.UTF8)) : [];
        return [.. paths.Select(path => Hashed(modFolder, path, lines.TryGetValue(path, out var line) ? line : null))];
    }

    public bool InstallationFileExists(string path) => File.Exists(path);

    public string InstallationFileName(string path) => Path.GetFileName(path);

    public bool WriteManifest(string modFolder, string modName, Manifest manifest)
    {
        var path = Path.Combine(modFolder, ManifestName(modName));
        var text = ManifestText.Of(manifest);
        if (File.Exists(path) && File.ReadAllText(path, Encoding.UTF8) == text) return false;

        File.WriteAllText(path, text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return true;
    }

    private HashedFile Hashed(string modFolder, string path, LineStamp? line)
    {
        var stamp = FileStamp.Of(Path.Combine(modFolder, path));
        if (stamp is { } now && line is { } known && known.Size == now.Size && known.Modified == now.Modified)
            return new HashedFile(path, known.Hash, now);

        var readFrom = time.GetUtcNow();
        using var content = new FileStream(Path.Combine(modFolder, path), FileMode.Open, FileAccess.Read, FileShare.Read);
        return new HashedFile(path, FileHash.Of(content), stamp is { } read && read.SettledAt(readFrom) ? read : null);
    }

    private static string ManifestName(string modName) => modName + ManifestExtension;
}
