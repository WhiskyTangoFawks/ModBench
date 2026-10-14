using System.Text;

namespace MEditService.ModFolderAdapter;

public sealed class ModFolderRepository(TimeProvider time) : IModFolderRepository
{
    private const string ManifestExtension = ".manifest";

    public ModFolderFiles Files(string modFolder, string modName, IReadOnlySet<string> leftOut, string? statCache)
    {
        var paths = new DirectoryInfo(modFolder).EnumerateFiles("*", SearchOption.AllDirectories)
            .Select(file => PathIn(modFolder, file.FullName))
            .Where(path => path != ManifestName(modName) && !leftOut.Contains(path))
            .ToList();
        if (statCache is null) return new([.. paths.Select(path => new HashedFile(path, HashOf(modFolder, path)))], StatCacheNotWritten: null);

        var cache = new StatCache(statCache, modFolder, time);
        List<HashedFile> files = [.. paths.Select(path => new HashedFile(path, cache.HashOf(path, () => HashOf(modFolder, path))))];
        return new(files, cache.Write(paths));
    }

    public Stream OpenFile(string modFolder, string path) => File.OpenRead(Path.Combine(modFolder, path));

    public bool InstallationFileExists(string path) => File.Exists(path);

    public string InstallationFileName(string path) => Path.GetFileName(path);

    public IReadOnlyList<string> FilePaths(string modFolder) =>
        Directory.Exists(modFolder)
            ? [.. Directory.EnumerateFiles(modFolder, "*", SearchOption.AllDirectories).Select(file => PathIn(modFolder, file))]
            : [];

    public string FolderName(string modFolder) => Path.GetFileName(Path.TrimEndingDirectorySeparator(modFolder));

    public string PathIn(string modFolder, string file) => Path.GetRelativePath(modFolder, file).Replace('\\', '/');

    public bool WriteFile(string folder, string path, Action<Stream> write)
    {
        var target = Path.Combine(folder, path);
        Directory.CreateDirectory(folder);
        var partial = Path.Combine(folder, ".medit_tmp_" + Path.GetRandomFileName() + ".tmp");
        try
        {
            using (var content = new FileStream(partial, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
                write(content);
            var there = File.Exists(target);
            if (there && SameBytes(partial, target)) return false;
            Directory.CreateDirectory(Path.GetDirectoryName(target) ?? folder);
            File.Move(partial, target, overwrite: true);
            return there;
        }
        finally
        {
            File.Delete(partial);
        }
    }

    private static bool SameBytes(string one, string other)
    {
        using var a = File.OpenRead(one);
        using var b = File.OpenRead(other);
        if (a.Length != b.Length) return false;
        Span<byte> left = stackalloc byte[1 << 14], right = stackalloc byte[1 << 14];
        int read;
        while ((read = a.ReadAtLeast(left, left.Length, throwOnEndOfStream: false)) > 0)
        {
            b.ReadExactly(right[..read]);
            if (!left[..read].SequenceEqual(right[..read])) return false;
        }
        return true;
    }

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

    public Manifest? ReadManifest(string modFolder, string modName)
    {
        var path = Path.Combine(modFolder, ManifestName(modName));
        return File.Exists(path) ? ManifestText.Parse(File.ReadAllText(path, Encoding.UTF8)) : null;
    }

    private static string HashOf(string modFolder, string path)
    {
        using var content = new FileStream(Path.Combine(modFolder, path), FileMode.Open, FileAccess.Read, FileShare.Read);
        return FileHash.Of(content);
    }

    private static string ManifestName(string modName) => modName + ManifestExtension;
}
