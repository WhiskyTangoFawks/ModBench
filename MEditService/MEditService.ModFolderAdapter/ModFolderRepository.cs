using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

public sealed class ModFolderRepository : IModFolderRepository
{
    public IReadOnlyDictionary<string, string> Hashes(string modFolder) =>
        FilePaths(modFolder).ToDictionary(path => path, path => HashOf(modFolder, path), StringComparer.Ordinal);

    public Stream OpenFile(string modFolder, string path) => File.OpenRead(Path.Combine(modFolder, path));

    public IReadOnlyList<string> FilePaths(string modFolder) =>
        Directory.Exists(modFolder)
            ? [.. Directory.EnumerateFiles(modFolder, "*", SearchOption.AllDirectories).Select(file => PathIn(modFolder, file)).Where(path => !TempName.HoldsTemp(path))]
            : [];

    public bool DataFolderExists(string dataFolder) => Directory.Exists(dataFolder);

    public string ExcludedName(string name, string exclusionMark) => name + exclusionMark;

    public string PathIn(string modFolder, string file) => Path.GetRelativePath(modFolder, file).Replace('\\', '/');

    public bool WriteFile(string folder, string path, Action<Stream> write)
    {
        var target = Path.Combine(folder, path);
        Directory.CreateDirectory(folder);
        TempName.RemoveLeftovers(folder);
        var partial = TempName.FileIn(folder);
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

    public void DeleteFile(string folder, string path) => File.Delete(Path.Combine(folder, path));

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

    private static string HashOf(string modFolder, string path)
    {
        using var content = new FileStream(Path.Combine(modFolder, path), FileMode.Open, FileAccess.Read, FileShare.Read);
        return FileHash.Of(content);
    }
}
