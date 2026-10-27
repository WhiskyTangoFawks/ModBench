namespace MEditService.ModFolderAdapter;

/// <summary>What a mod's manifest says: its packages, each named once with its pin, and each file's place in its package.
/// A file names its package only when it is not the first (ADR-0013).</summary>
public sealed record Manifest(IReadOnlyList<ManifestPackage> Packages, IReadOnlyList<ManifestFile> Files, string? Version = null)
{
    public Manifest(ManifestPackage? package, IReadOnlyList<ManifestFile> files, string? version = null)
        : this(package is null ? [] : [package], files, version)
    {
    }

    /// <summary>The package a file is in when it names none.</summary>
    public ManifestPackage? Package => Packages.Count > 0 ? Packages[0] : null;

    /// <summary>The name of the folder it builds, which a manifest outside that folder names, as a source mod's does
    /// (modlist-repository.md, The manifest, story 20).</summary>
    public string? Output { get; init; }

    /// <summary>Each path in the folder a source mod's build writes under the mod manager's exclusion mark.</summary>
    public IReadOnlyList<string> Exclude { get; init; } = [];

    /// <summary>Each archive a source mod's build packs (mods.md, Build, story 2).</summary>
    public IReadOnlyList<ManifestArchive> Archives { get; init; } = [];

    /// <summary>The steps that build the folder, in the order they run (modlist-repository.md, The manifest, story 17).</summary>
    public IReadOnlyList<ManifestStep> Steps { get; init; } = [];

    /// <summary>The tools its steps run, each by its task's label (modlist-repository.md, The manifest, story 18).</summary>
    public IReadOnlyList<ManifestTool> Tools { get; init; } = [];

    public static bool IsFolderName(string name) => IsPathInTheFolder(name) && !name.Contains('/', StringComparison.Ordinal);

    /// <summary>A forward-slash path that stays inside the folder.</summary>
    public static bool IsPathInTheFolder(string path) =>
        !path.Contains('\\', StringComparison.Ordinal) && !System.IO.Path.IsPathRooted(path)
        && path.Split('/').All(segment => !string.IsNullOrWhiteSpace(segment) && segment is not ("." or ".."));

    internal static string NameOf(ManifestPackage package) => package switch
    {
        ManifestPackage.InstallationFile installationFile => installationFile.Name,
        ManifestPackage.SourceRepository repository => repository.Name,
        ManifestPackage.GameFolder gameFolder => gameFolder.Name,
        _ => throw new ArgumentOutOfRangeException(nameof(package), package, null),
    };

    /// <summary>The package <paramref name="file"/>'s line is in; none when it names one the manifest does not.</summary>
    public ManifestPackage? PackageOf(ManifestFile file) =>
        file.Package is { } name ? Packages.FirstOrDefault(package => NameOf(package) == name) : Package;

    public FileBytes BytesOf(ManifestFile file) => (PackageOf(file), file.Entry) switch
    {
        (_, PackageEntry.NotHeld) => new FileBytes.NotHeld(),
        (_, PackageEntry.OtherBytes) => new FileBytes.OtherBytes(),
        (_, PackageEntry.MadeByStep) => new FileBytes.MadeByStep(),
        (null, _) => new FileBytes.NoInstallationFile(),
        (ManifestPackage.InstallationFile installationFile, var entry) => new FileBytes.InInstallationFile(installationFile.Name, entry.PathOf(file.Path)),
        (ManifestPackage.SourceRepository, var entry) => new FileBytes.Built(entry.PathOf(file.Path)),
        (ManifestPackage.GameFolder, var entry) => new FileBytes.InGameFolder(entry.PathOf(file.Path)),
        _ => throw new ArgumentOutOfRangeException(nameof(file), file, null),
    };

    /// <summary>The hash, or the repository whose last build wrote it, that fixes <paramref name="file"/>'s bytes, and its
    /// path in the package. Null when the line names no bytes.</summary>
    internal (string Package, string Path)? FixedBy(ManifestFile file) => (BytesOf(file), PackageOf(file)) switch
    {
        (FileBytes.InInstallationFile held, ManifestPackage.InstallationFile installationFile) => (installationFile.Hash, held.Path),
        (FileBytes.Built built, ManifestPackage.SourceRepository repository) => (repository.Name, built.Path),
        (FileBytes.InGameFolder taken, ManifestPackage.GameFolder gameFolder) => (gameFolder.Hash, taken.Path),
        _ => null,
    };
}

/// <summary>A step that runs the VS Code task labelled <paramref name="Task"/> with <paramref name="Args"/>.</summary>
public sealed record ManifestStep(string Task, IReadOnlyList<string> Args);

/// <summary>The tool a step runs through the VS Code task labelled <paramref name="Task"/>, and where to get it.</summary>
public sealed record ManifestTool(string Task, string Page);

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

    /// <summary>The package holds a file at the line's path, with other bytes.</summary>
    public sealed record OtherBytes : FileBytes
    {
        internal OtherBytes() { }
    }

    public sealed record MadeByStep : FileBytes
    {
        internal MadeByStep() { }
    }

    public sealed record NoInstallationFile : FileBytes
    {
        internal NoInstallationFile() { }
    }
}

/// <summary>A file of the mod folder, and where its package holds it.</summary>
public sealed record ManifestFile(string Path, PackageEntry Entry, string? Package = null)
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

    /// <summary>The package holds a file at the file's path, with other bytes.</summary>
    public sealed record OtherBytes : PackageEntry;

    public sealed record MadeByStep : PackageEntry;

    internal static PackageEntry At(string filePath, string packagePath) =>
        string.Equals(filePath, packagePath, StringComparison.OrdinalIgnoreCase) ? new Held() : new HeldAt(packagePath);

    internal virtual string PathOf(string filePath) => filePath;
}
