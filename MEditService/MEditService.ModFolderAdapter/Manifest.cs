using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

/// <summary>What a mod's manifest says: the installation files and game files its files come from, then each
/// file's provider. A source's hash is the Instance adapter's text, kept as written (ADR-0024).</summary>
public sealed record Manifest(
    IReadOnlyList<ManifestSource> InstallationFiles,
    IReadOnlyList<ManifestSource> GameFiles,
    IReadOnlyList<ManifestFile> Files);

/// <summary>An installation file by its name, or a game file by its path under the game folder. Source is
/// where the mod manager says the installation file comes from.</summary>
public sealed record ManifestSource(string Name, long Size, string Hash, string? Source = null);

/// <summary>A file of the mod folder. The stamp is what status trusts in place of a hash, and is null when the
/// file system could not give one.</summary>
public sealed record ManifestFile(string Path, string Hash, FileStamp? Stamp, FileProvider Provider);

public abstract record FileProvider
{
    private FileProvider() { }

    /// <summary>The mod's first installation file holds the file at the same path.</summary>
    public sealed record FirstInstallationFile : FileProvider;

    public sealed record InstallationFileEntry(string InstallationFile, string Path) : FileProvider;

    public sealed record GameFile(string Path) : FileProvider;

    /// <summary>The delta named for the file, applied to the installation file's entry at Path, whose hash is
    /// BaseHash.</summary>
    public sealed record InstallationFileDelta(string InstallationFile, string Path, string BaseHash) : FileProvider;

    /// <summary>The delta named for the file, applied to the game file at Path, whose hash is BaseHash.</summary>
    public sealed record GameFileDelta(string Path, string BaseHash) : FileProvider;

    public sealed record NoProvider : FileProvider;
}
