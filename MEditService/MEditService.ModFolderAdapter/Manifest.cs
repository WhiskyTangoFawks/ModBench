namespace MEditService.ModFolderAdapter;

/// <summary>What a mod's manifest says: its one package, if any, and each file's place in it. The package's hash is the
/// Instance adapter's text, kept as written (ADR-0013).</summary>
public sealed record Manifest(ManifestPackage? Package, IReadOnlyList<ManifestFile> Files, string? Version = null)
{
    /// <summary>The name of the folder it builds, which a manifest outside that folder names, as a source mod's does
    /// (modlist-repository.md, The manifest, story 20).</summary>
    public string? Output { get; init; }

    /// <summary>Each path in the folder a source mod's build writes under the mod manager's exclusion mark.</summary>
    public IReadOnlyList<string> Exclude { get; init; } = [];

    /// <summary>Each archive a source mod's build packs (mods.md, Build, story 2).</summary>
    public IReadOnlyList<ManifestArchive> Archives { get; init; } = [];

    public static bool IsFolderName(string name) => IsPathInTheFolder(name) && !name.Contains('/', StringComparison.Ordinal);

    /// <summary>A forward-slash path that stays inside the folder.</summary>
    public static bool IsPathInTheFolder(string path) =>
        !path.Contains('\\', StringComparison.Ordinal) && !System.IO.Path.IsPathRooted(path)
        && path.Split('/').All(segment => !string.IsNullOrWhiteSpace(segment) && segment is not ("." or ".."));

    public FileBytes BytesOf(ManifestFile file) => (Package, file.Entry) switch
    {
        (_, PackageEntry.NotHeld) => new FileBytes.NotHeld(),
        (null, _) => new FileBytes.NoInstallationFile(),
        (ManifestPackage.InstallationFile installationFile, var entry) => new FileBytes.InInstallationFile(installationFile.Name, entry.PathOf(file.Path)),
        (ManifestPackage.SourceRepository, var entry) => new FileBytes.Built(entry.PathOf(file.Path)),
        (ManifestPackage.GameFolder, var entry) => new FileBytes.InGameFolder(entry.PathOf(file.Path)),
        _ => throw new ArgumentOutOfRangeException(nameof(file), file, null),
    };

    /// <summary>The hash, or the repository whose last build wrote it, that fixes <paramref name="file"/>'s bytes, and its
    /// path in the package. Null when the line names no bytes.</summary>
    internal (string Package, string Path)? FixedBy(ManifestFile file) => (BytesOf(file), Package) switch
    {
        (FileBytes.InInstallationFile held, ManifestPackage.InstallationFile installationFile) => (installationFile.Hash, held.Path),
        (FileBytes.Built built, ManifestPackage.SourceRepository repository) => (repository.Name, built.Path),
        (FileBytes.InGameFolder taken, ManifestPackage.GameFolder gameFolder) => (gameFolder.Hash, taken.Path),
        _ => null,
    };
}

/// <summary>An archive to pack at <paramref name="Path"/> in the folder from the files of the build at <paramref name="Files"/>.</summary>
public sealed record ManifestArchive(string Path, IReadOnlyList<string> Files);

public abstract record ManifestPackage
{
    private ManifestPackage() { }

    /// <summary>The downloaded file the mod was installed from, with its page on its host.</summary>
    public sealed record InstallationFile(string Name, long Size, string Hash, string? Page = null) : ManifestPackage;

    /// <summary>A source mod's repository by its folder's name, which names its submodule when it is one. Git holds a
    /// submodule's remote, pin and branch; a repository that is no submodule has no host (ADR-0022).</summary>
    public sealed record SourceRepository(string Name, bool IsSubmodule) : ManifestPackage;

    /// <summary>The game folder by the game's name, pinned by a hash of the files the mod takes from it (ADR-0022).</summary>
    public sealed record GameFolder(string Name, string Hash) : ManifestPackage;
}

/// <summary>Where a manifest line's bytes are.</summary>
public abstract record FileBytes
{
    private FileBytes() { }

    public sealed record InInstallationFile(string Name, string Path) : FileBytes;

    /// <summary>The file at <paramref name="Path"/> as the source mod's build writes it.</summary>
    public sealed record Built(string Path) : FileBytes;

    public sealed record InGameFolder(string Path) : FileBytes;

    public sealed record NotHeld : FileBytes
    {
        internal NotHeld() { }
    }

    public sealed record NoInstallationFile : FileBytes
    {
        internal NoInstallationFile() { }
    }
}

/// <summary>A file of the mod folder, and where its package holds it.</summary>
public sealed record ManifestFile(string Path, PackageEntry Entry)
{
    /// <summary>The line for the file at <paramref name="path"/> whose bytes <paramref name="bytes"/> locates in the package.</summary>
    public static ManifestFile At(string path, FileBytes.InInstallationFile bytes) => new(path, PackageEntry.At(path, bytes.Path));
}

public abstract record PackageEntry
{
    private PackageEntry() { }

    /// <summary>The package holds the file at the file's own path.</summary>
    public sealed record Held : PackageEntry;

    /// <summary>The package holds the file at another path, as a FOMOD install moves files.</summary>
    internal sealed record HeldAt(string Path) : PackageEntry
    {
        internal override string PathOf(string filePath) => Path;
    }

    public sealed record NotHeld : PackageEntry;

    internal static PackageEntry At(string filePath, string packagePath) =>
        string.Equals(filePath, packagePath, StringComparison.OrdinalIgnoreCase) ? new Held() : new HeldAt(packagePath);

    internal virtual string PathOf(string filePath) => filePath;
}
