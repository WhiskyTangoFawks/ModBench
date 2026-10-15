namespace MEditService.ModFolderAdapter;

/// <summary>What a mod's manifest says: the installation files and game files its files come from, then each
/// file's provider. A source's hash is the Instance adapter's text, kept as written (ADR-0013).</summary>
public sealed record Manifest(
    IReadOnlyList<ManifestSource> InstallationFiles,
    IReadOnlyList<ManifestSource> GameFiles,
    IReadOnlyList<ManifestFile> Files)
{
    /// <summary>The provider of <paramref name="file"/>, by its source's hash, or the commit its source builds at, and the
    /// path in it: what fixes the file's bytes. Null when the line names none.</summary>
    internal (string Source, string Path)? ProviderOf(ManifestFile file) => file.Provider switch
    {
        FileProvider.FirstInstallationFile when InstallationFiles is [var first, ..] => (first.Hash, file.Path),
        FileProvider.InstallationFileEntry entry when InstallationFiles.FirstOrDefault(source => source.Name == entry.InstallationFile) is { } named =>
            (named.Hash, entry.Path),
        FileProvider.GameFile game
            when GameFiles.FirstOrDefault(source => string.Equals(source.Name, game.Path, StringComparison.OrdinalIgnoreCase)) is { } named =>
            (named.Hash, game.Path),
        FileProvider.Source source => (source.Commit, file.Path),
        _ => null,
    };
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

    public sealed record GameFile(string Path) : FileProvider;

    /// <summary>The mod's source, shared through <paramref name="Remote"/>, builds the file at <paramref name="Commit"/>
    /// (ADR-0022).</summary>
    public sealed record Source(string Remote, string Commit) : FileProvider;

    public sealed record NoProvider : FileProvider;
}
