using System.Text;

namespace MEditService.ModFolderAdapter;

public sealed class ModFolderRepository(TimeProvider time) : IModFolderRepository
{
    private const string ManifestExtension = ".manifest";

    public ModFolderFiles Files(string modFolder, string modName, IReadOnlySet<string> leftOut, string? statCache)
    {
        var paths = FilesOf(modFolder, modName).Where(path => !leftOut.Contains(path)).ToList();
        if (statCache is null) return new([.. paths.Select(path => new HashedFile(path, HashOf(modFolder, path)))]);

        var cache = new StatCache(statCache, modFolder, time);
        return new([.. paths.Select(path => new HashedFile(path, cache.HashOf(path, () => HashOf(modFolder, path))))]) { StatCache = cache };
    }

    public string? KeepInStatCache(ModFolderFiles read, Manifest manifest, IReadOnlyDictionary<string, string> provided)
    {
        if (read.StatCache is not { } cache) return null;
        Dictionary<(string Source, string Path), string> providers = [];
        foreach (var line in manifest.Files)
        {
            if (manifest.ProviderOf(line) is { } provider && provided.TryGetValue(line.Path, out var hash)) providers.TryAdd(provider, hash);
        }
        return cache.Write([.. read.Files.Select(file => file.Path)], providers);
    }

    public IReadOnlyList<string> NamedByNoLine(string modFolder, string modName, Manifest manifest, IReadOnlySet<string> leftOut)
    {
        var named = manifest.Files.Select(line => line.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);
        return [.. FilesOf(modFolder, modName).Where(path => !named.Contains(path) && !leftOut.Contains(path))];
    }

    public RestoreDestroys WhatRestoreDestroys(string modFolder, string modName, IReadOnlySet<string> leftOut, string statCache)
    {
        Manifest? manifest;
        try
        {
            manifest = ReadManifest(modFolder, modName);
        }
        catch (InvalidDataException)
        {
            manifest = null;
        }
        if (manifest is null) return new([], []);

        var cache = new StatCache(statCache, modFolder, time);
        List<string> differing = [];
        foreach (var line in manifest.Files.Where(line => File.Exists(Path.Combine(modFolder, line.Path))))
        {
            if (manifest.ProviderOf(line) is { } provider && !HoldsWhatItsProviderFixes(modFolder, line.Path, cache, provider)) differing.Add(line.Path);
        }
        return new(differing, NamedByNoLine(modFolder, modName, manifest, leftOut));
    }

    private static bool HoldsWhatItsProviderFixes(string modFolder, string path, StatCache cache, (string Source, string Path) provider)
    {
        if (cache.HashFixedBy(provider) is not { } fixedHash) return false;
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
