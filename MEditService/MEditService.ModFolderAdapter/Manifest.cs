namespace MEditService.ModFolderAdapter;

/// <summary>What a mod's manifest says: its one package, if any, and each file's place in it. The package's hash is the
/// Instance adapter's text, kept as written (ADR-0013).</summary>
public sealed record Manifest(ManifestPackage? Package, IReadOnlyList<ManifestFile> Files, string? Version = null)
{
    public FileBytes BytesOf(ManifestFile file) => (Package, file.Entry) switch
    {
        (_, PackageEntry.NotHeld) => new FileBytes.NotHeld(),
        (null, _) => new FileBytes.NoInstallationFile(),
        (ManifestPackage.InstallationFile installationFile, var entry) => new FileBytes.InInstallationFile(installationFile.Name, entry.PathOf(file.Path)),
        (ManifestPackage.SourceMod sourceMod, var entry) => new FileBytes.AtCommit(sourceMod.Commit, entry.PathOf(file.Path)),
        _ => throw new ArgumentOutOfRangeException(nameof(file), file, null),
    };

    /// <summary>The hash or commit that fixes <paramref name="file"/>'s bytes, and its path in the package. Null when the
    /// line names no bytes.</summary>
    internal (string Package, string Path)? FixedBy(ManifestFile file) => (BytesOf(file), Package) switch
    {
        (FileBytes.InInstallationFile held, ManifestPackage.InstallationFile installationFile) => (installationFile.Hash, held.Path),
        (FileBytes.AtCommit built, _) => (built.Commit, built.Path),
        _ => null,
    };
}

public abstract record ManifestPackage
{
    private ManifestPackage() { }

    /// <summary>The downloaded file the mod was installed from, with its page on its host.</summary>
    public sealed record InstallationFile(string Name, long Size, string Hash, string? Page = null) : ManifestPackage;

    public sealed record SourceMod(string Remote, string Commit) : ManifestPackage;
}

/// <summary>Where a manifest line's bytes are.</summary>
public abstract record FileBytes
{
    private FileBytes() { }

    public sealed record InInstallationFile(string Name, string Path) : FileBytes;

    public sealed record AtCommit(string Commit, string Path) : FileBytes;

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
    public sealed record HeldAt(string Path) : PackageEntry
    {
        internal override string PathOf(string filePath) => Path;
    }

    public sealed record NotHeld : PackageEntry;

    public static PackageEntry At(string filePath, string packagePath) =>
        string.Equals(filePath, packagePath, StringComparison.OrdinalIgnoreCase) ? new Held() : new HeldAt(packagePath);

    internal virtual string PathOf(string filePath) => filePath;
}
