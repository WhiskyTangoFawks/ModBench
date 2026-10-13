namespace MEditService.ModFolderAdapter;

/// <summary>The one reader of a mod folder's files and the one writer of a mod's manifest, which keeps each file's
/// hash (ADR-0013), and of the deltas in the build folder.</summary>
public interface IModFolderRepository
{
    /// <summary>Every file of the mod but its manifest and those left out, by forward-slash path relative to
    /// <paramref name="modFolder"/>. A file whose size and time match its manifest line keeps the line's hash.</summary>
    IReadOnlyList<HashedFile> Files(string modFolder, string modName, IReadOnlySet<string> leftOut);

    Stream OpenFile(string modFolder, string path);

    bool InstallationFileExists(string path);

    /// <summary>The name of the installation file at <paramref name="path"/>, without its folder.</summary>
    string InstallationFileName(string path);

    Stream OpenInstallationFile(string path);

    /// <summary>The game file at the forward-slash <paramref name="path"/> under <paramref name="dataFolder"/>.</summary>
    Stream OpenGameFile(string dataFolder, string path);

    /// <summary>Writes the mod's manifest into its folder, and only when its text differs from the one there.
    /// True when it wrote.</summary>
    bool WriteManifest(string modFolder, string modName, Manifest manifest);

    /// <summary>The size of the delta in <paramref name="buildFolder"/> that makes the file at
    /// <paramref name="path"/> with <paramref name="fileHash"/> from a base with <paramref name="baseHash"/>, or
    /// null when there is none.</summary>
    long? DeltaSize(string buildFolder, string path, string baseHash, string fileHash);

    /// <summary>Hands <paramref name="write"/> the delta's stream, and keeps the delta only when it answers true.
    /// True when kept.</summary>
    bool WriteDelta(string buildFolder, string path, string baseHash, string fileHash, Func<Stream, bool> write);

    /// <summary>An empty seekable file in <paramref name="buildFolder"/>, deleted when closed.</summary>
    Stream CreateScratchFile(string buildFolder);
}
