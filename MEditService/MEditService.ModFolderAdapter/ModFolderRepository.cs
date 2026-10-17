using System.Text;

namespace MEditService.ModFolderAdapter;

/// <summary><paramref name="fileExists"/> is the file system's answer to whether a file is at a path, in the case it
/// matches names in.</summary>
public sealed class ModFolderRepository(TimeProvider time, Func<string, bool> fileExists) : IModFolderRepository
{
    private const string ManifestExtension = ".manifest";

    public ModFolderRepository(TimeProvider time) : this(time, File.Exists)
    {
    }

    public ModFolderFiles Files(string modFolder, string modName, IReadOnlySet<string> leftOut, string? statCache)
    {
        var paths = FilesOf(modFolder, modName).Where(path => !leftOut.Contains(path)).ToList();
        if (statCache is null) return new([.. paths.Select(path => new HashedFile(path, HashOf(modFolder, path)))]);

        var cache = new StatCache(statCache, modFolder, time);
        return new([.. paths.Select(path => new HashedFile(path, cache.HashOf(path, () => HashOf(modFolder, path))))]) { StatCache = cache };
    }

    public string? KeepInStatCache(ModFolderFiles read, Manifest manifest, IReadOnlyDictionary<string, string> hashes)
    {
        if (read.StatCache is not { } cache) return null;
        Dictionary<(string Package, string Path), string> fixes = [];
        foreach (var line in manifest.Files)
        {
            if (manifest.FixedBy(line) is { } fixedBy && hashes.TryGetValue(line.Path, out var hash)) fixes.TryAdd(fixedBy, hash);
        }
        return cache.Write([.. read.Files.Select(file => file.Path)], fixes);
    }

    public IReadOnlyList<string> NamedByNoLine(string modFolder, string modName, Manifest manifest, IReadOnlySet<string> leftOut)
    {
        var onDisk = FilesOf(modFolder, modName).ToHashSet(StringComparer.Ordinal);
        var lines = manifest.Files.Select(line => line.Path).ToHashSet(StringComparer.Ordinal);
        var linesInAnyCase = lines.ToLookup(line => line, StringComparer.OrdinalIgnoreCase);
        return [.. onDisk.Where(path => !leftOut.Contains(path) && !lines.Contains(path) && !linesInAnyCase[path].Any(line => FoundAt(modFolder, line, onDisk)))];
    }

    // A line names a file in another case only where the file system finds that file by the line's name: no file of its
    // own has that name, and yet one is there.
    private bool FoundAt(string modFolder, string line, HashSet<string> onDisk) =>
        !onDisk.Contains(line) && fileExists(Path.Combine(modFolder, line));

    public ModStatus Status(string modFolder, string modName, IReadOnlySet<string> leftOut, string statCache, ModMetadata? held = null)
    {
        try
        {
            if (ReadManifest(modFolder, modName) is not { } manifest) return new(modName, NoManifest: true, [], [], [], []);

            var cache = new StatCache(statCache, modFolder, time);
            var onDisk = FilesOf(modFolder, modName).ToHashSet(StringComparer.Ordinal);
            List<string> differing = [], gone = [], notInPackage = [];
            foreach (var line in manifest.Files)
            {
                var fixedBy = manifest.FixedBy(line);
                if (fixedBy is null) notInPackage.Add(line.Path);
                if (!fileExists(Path.Combine(modFolder, line.Path))) gone.Add(line.Path);
                else if (fixedBy is { } fixes && !HoldsWhatItIsFixedBy(modFolder, line.Path, cache, fixes)) differing.Add(OnDisk(line.Path, onDisk));
            }
            var namedByNoLine = NamedByNoLine(modFolder, modName, manifest, leftOut);
            var statCacheNotWritten = cache.Keep([.. onDisk.Where(path => !leftOut.Contains(path))]);
            var says = ModMetadata.Of(manifest);
            return new(
                modName, NoManifest: false, Ordered(differing), Ordered(namedByNoLine), Ordered(gone), Ordered(notInPackage), null, statCacheNotWritten,
                held?.DiffersFrom(says) == true, says);
        }
        catch (InvalidDataException e)
        {
            return new(modName, NoManifest: false, [], [], [], [], new ModUnreadable(Manifest: true, e.Message));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return new(modName, NoManifest: false, [], [], [], [], new ModUnreadable(Manifest: false, $"a file could not be read: {e.Message}"));
        }
    }

    // A line found by the file system names the file on disk in its own case where none has the line's (NamedByNoLine).
    private static string OnDisk(string line, HashSet<string> onDisk) =>
        onDisk.Contains(line) ? line : onDisk.FirstOrDefault(path => string.Equals(path, line, StringComparison.OrdinalIgnoreCase)) ?? line;

    private static string[] Ordered(IEnumerable<string> paths) => [.. paths.Order(StringComparer.Ordinal)];

    private static bool HoldsWhatItIsFixedBy(string modFolder, string path, StatCache cache, (string Package, string Path) fixedBy)
    {
        if (cache.HashFixedBy(fixedBy) is not { } fixedHash) return false;
        try
        {
            return cache.HashOf(path, () => HashOf(modFolder, path)) == fixedHash;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private IEnumerable<string> FilesOf(string modFolder, string modName) =>
        new DirectoryInfo(modFolder).EnumerateFiles("*", SearchOption.AllDirectories)
            .Select(file => PathIn(modFolder, file.FullName))
            .Where(path => path != ManifestName(modName));

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
