using System.Text;
using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

public sealed class ModFolderRepository(TimeProvider time) : IModFolderRepository
{
    public ModFolderFiles Files(string modFolder, IReadOnlySet<string> leftOut, string? statCache)
    {
        var paths = FilesOf(modFolder).Where(path => !leftOut.Contains(path)).ToList();
        if (statCache is null) return new([.. paths.Select(path => new HashedFile(path, HashOf(modFolder, path)))]);

        var cache = new StatCache(statCache, modFolder, time);
        return new([.. paths.Select(path => new HashedFile(path, cache.HashOf(path, () => HashOf(modFolder, path))))]) { StatCache = cache };
    }

    public IScratchFiles CreateScratchFiles() => new ScratchFiles();

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

    private IEnumerable<string> FilesOf(string modFolder) =>
        new DirectoryInfo(modFolder).EnumerateFiles("*", SearchOption.AllDirectories)
            .Select(file => PathIn(modFolder, file.FullName))
            .Where(path => !string.Equals(path, ManifestName.Of(FolderName(modFolder)), StringComparison.OrdinalIgnoreCase) && !TempName.HoldsTemp(path));

    // modlist-repository.md, The manifest, story 16: named for the folder it builds, in any case, as Modbench finds it, so a
    // folder reads alike on Windows and Linux. Where two names differ in case alone, neither is the manifest.
    private string ManifestOf(string modFolder)
    {
        var named = ManifestName.Of(FolderName(modFolder));
        List<string> held = Directory.Exists(modFolder)
            ? [.. Directory.EnumerateFiles(modFolder).Select(Path.GetFileName).OfType<string>()
                .Where(name => string.Equals(name, named, StringComparison.OrdinalIgnoreCase)).Order(StringComparer.Ordinal)]
            : [];
        return held switch
        {
            [] => named,
            [var one] => one,
            [var one, var other, ..] => throw new InvalidDataException($"its folder holds two manifests, '{one}' and '{other}'"),
        };
    }

    public Stream OpenFile(string modFolder, string path) => File.OpenRead(Path.Combine(modFolder, path));

    public bool InstallationFileExists(string path) => File.Exists(path);

    public string InstallationFileName(string path) => Path.GetFileName(path);

    public IReadOnlyList<string> FilePaths(string modFolder) =>
        Directory.Exists(modFolder)
            ? [.. Directory.EnumerateFiles(modFolder, "*", SearchOption.AllDirectories).Select(file => PathIn(modFolder, file)).Where(path => !TempName.HoldsTemp(path))]
            : [];

    public bool DataFolderExists(string dataFolder) => Directory.Exists(dataFolder);

    public string ExcludedName(string name, string exclusionMark) => name + exclusionMark;

    public string FolderName(string modFolder) => Path.GetFileName(Path.TrimEndingDirectorySeparator(modFolder));

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

    public Stream OpenGameFile(string root, string path) => File.OpenRead(Path.Combine(root, path));

    public SpelledManifest? RemoveManifest(string modFolder, string sourceFolder)
    {
        var name = ManifestOf(modFolder);
        var path = Path.Combine(modFolder, name);
        if (SameFolder(modFolder, sourceFolder) || !File.Exists(path)) return null;
        var removed = new SpelledManifest(name, File.ReadAllBytes(path));
        File.Delete(path);
        return removed;
    }

    private static bool SameFolder(string one, string other) =>
        string.Equals(
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(one)), Path.TrimEndingDirectorySeparator(Path.GetFullPath(other)),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    public Manifest? ReadManifest(string modFolder)
    {
        var path = Path.Combine(modFolder, ManifestOf(modFolder));
        return File.Exists(path) ? ManifestText.Parse(File.ReadAllText(path, Encoding.UTF8)) : null;
    }

    private static string HashOf(string modFolder, string path)
    {
        using var content = new FileStream(Path.Combine(modFolder, path), FileMode.Open, FileAccess.Read, FileShare.Read);
        return FileHash.Of(content);
    }

    public Answer<Manifest?, string> ReadSourceManifest(string sourceFolder)
    {
        try
        {
            List<string> held = Directory.Exists(sourceFolder) ? ManifestsIn(sourceFolder) : [];
            if (held is []) return (Manifest?)null;
            if (held is [var one, var other, ..]) return $"its repository holds two manifests, '{Path.GetFileName(one)}' and '{Path.GetFileName(other)}'";
            var name = Path.GetFileName(held[0]);
            var manifest = ManifestText.Parse(File.ReadAllText(held[0], Encoding.UTF8));
            if (manifest.Output is not { } output) return "its manifest names no output folder";
            return name == ManifestName.Of(output) ? manifest : $"its manifest '{name}' is not named for its output folder '{output}'";
        }
        catch (InvalidDataException e)
        {
            return e.Message;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return $"its manifest could not be read: {e.Message}";
        }
    }

    public bool WriteSourceManifest(string sourceFolder, Manifest manifest)
    {
        var spelled = SpellSourceManifest(manifest);
        var path = Path.Combine(sourceFolder, spelled.Name);
        var there = ManifestsIn(sourceFolder).SingleOrDefault();
        // A name that differs in case alone is the same file where the file system matches names without case.
        if (there is not null && there != path && string.Equals(there, path, StringComparison.OrdinalIgnoreCase))
        {
            File.Move(there, path);
            there = path;
        }
        if (there == path && File.ReadAllBytes(path).AsSpan().SequenceEqual(spelled.Text)) return false;

        WriteFile(sourceFolder, spelled.Name, content => content.Write(spelled.Text));
        if (there is null || there == path) return true;
        try
        {
            File.Delete(there);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            File.Delete(path);
            throw;
        }
        return true;
    }

    public SpelledManifest SpellSourceManifest(Manifest manifest) =>
        new(ManifestName.Of(manifest.Output ?? throw new ArgumentException("A source mod's manifest names its output folder.", nameof(manifest))),
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(ManifestText.Of(manifest)));

    private static List<string> ManifestsIn(string sourceFolder) =>
        [.. Directory.EnumerateFiles(sourceFolder).Where(path => ManifestName.Is(Path.GetFileName(path))).Order(StringComparer.Ordinal)];
}
