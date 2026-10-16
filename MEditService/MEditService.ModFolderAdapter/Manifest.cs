namespace MEditService.ModFolderAdapter;

/// <summary>What a mod's manifest says: the installation files and game files its files come from, then each
/// file's provider. A source's hash is the Instance adapter's text, kept as written (ADR-0013).</summary>
public sealed record Manifest(
    IReadOnlyList<ManifestSource> InstallationFiles,
    IReadOnlyList<ManifestSource> GameFiles,
    IReadOnlyList<ManifestFile> Files,
    string? Version = null)
{
    /// <summary>The bytes <paramref name="file"/>'s line names: where they are, before any file is looked at.</summary>
    public FileBytes BytesOf(ManifestFile file) => file.Provider switch
    {
        FileProvider.FirstInstallationFile => InstallationFiles is [var first, ..]
            ? new FileBytes.InInstallationFile(first.Name, file.Path)
            : new FileBytes.NoInstallationFile(),
        FileProvider.InstallationFileEntry entry => new FileBytes.InInstallationFile(entry.InstallationFile, entry.Path),
        FileProvider.GameFile game => new FileBytes.InGameFile(game.Path),
        FileProvider.Source source => new FileBytes.AtCommit(source.Remote, source.Commit, file.Path),
        FileProvider.NoProvider => new FileBytes.Unnamed(),
        _ => throw new ArgumentOutOfRangeException(nameof(file), file.Provider, null),
    };

    /// <summary>The provider of <paramref name="file"/>, by its source's hash, or the commit its source builds at, and the
    /// path in it: what fixes the file's bytes. Null when the line names none.</summary>
    internal (string Source, string Path)? ProviderOf(ManifestFile file) => BytesOf(file) switch
    {
        FileBytes.InInstallationFile held when InstallationFiles.FirstOrDefault(source => source.Name == held.Name) is { } named =>
            (named.Hash, held.Path),
        FileBytes.InGameFile game
            when GameFiles.FirstOrDefault(source => string.Equals(source.Name, game.Path, StringComparison.OrdinalIgnoreCase)) is { } named =>
            (named.Hash, game.Path),
        FileBytes.AtCommit built => (built.Commit, built.Path),
        _ => null,
    };
}

/// <summary>Where a manifest line's bytes are.</summary>
public abstract record FileBytes
{
    private FileBytes() { }

    public sealed record InInstallationFile(string Name, string Path) : FileBytes;

    public sealed record InGameFile(string Path) : FileBytes;

    public sealed record AtCommit(string Remote, string Commit, string Path) : FileBytes;

    public sealed record Unnamed : FileBytes;

    public sealed record NoInstallationFile : FileBytes;
}

/// <summary>An installation file by its name, or a game file by its path under the game folder. Source is
/// where the mod manager says the installation file comes from.</summary>
public sealed record ManifestSource(string Name, long Size, string Hash, string? Source = null);

/// <summary>A file of the mod folder, whose bytes its provider fixes.</summary>
public sealed record ManifestFile(string Path, FileProvider Provider);

public abstract record FileProvider
{
    private FileProvider() { }

    /// <summary>The mod's first installation file holds the file at the same path.</summary>
    public sealed record FirstInstallationFile : FileProvider;

    public sealed record InstallationFileEntry(string InstallationFile, string Path) : FileProvider;

    /// <summary>The provider that makes <see cref="Manifest.BytesOf"/> name <paramref name="held"/> for the line at
    /// <paramref name="linePath"/>.</summary>
    public static FileProvider Holding(FileBytes.InInstallationFile held, string firstInstallationFile, string linePath) =>
        held.Name == firstInstallationFile && string.Equals(held.Path, linePath, StringComparison.OrdinalIgnoreCase)
            ? new FirstInstallationFile()
            : new InstallationFileEntry(held.Name, held.Path);

    public sealed record GameFile(string Path) : FileProvider;

    /// <summary>The mod's source, shared through <paramref name="Remote"/>, builds the file at <paramref name="Commit"/>
    /// (ADR-0022).</summary>
    public sealed record Source(string Remote, string Commit) : FileProvider;

    public sealed record NoProvider : FileProvider;
}
