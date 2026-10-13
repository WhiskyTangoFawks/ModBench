namespace MEditService.ModFolderAdapter;

/// <summary>The one reader of a mod folder's files and the one writer of a mod's manifest, which keeps each file's
/// hash (ADR-0024).</summary>
public interface IModFolderRepository
{
    /// <summary>Every file of the mod but its manifest and those left out, by forward-slash path relative to
    /// <paramref name="modFolder"/>. A file whose size and time match its manifest line keeps the line's hash.</summary>
    IReadOnlyList<HashedFile> Files(string modFolder, string modName, IReadOnlySet<string> leftOut);

    bool InstallationFileExists(string path);

    /// <summary>The name of the installation file at <paramref name="path"/>, without its folder.</summary>
    string InstallationFileName(string path);

    Stream OpenFile(string folder, string path);

    /// <summary>Writes the mod's manifest into its folder, and only when its text differs from the one there.
    /// True when it wrote.</summary>
    bool WriteManifest(string modFolder, string modName, Manifest manifest);
}
