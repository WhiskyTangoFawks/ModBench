namespace MEditService.ModFolderAdapter;

/// <summary>The one reader of a mod folder's files and the one writer of a mod's manifest.</summary>
public interface IModFolderRepository
{
    /// <summary>Every file of the mod but its manifest and those left out, by forward-slash path. A file whose size and
    /// time match its manifest line goes unread, holding the hash <paramref name="provided"/> gives its path.</summary>
    IReadOnlyList<HashedFile> Files(
        string modFolder, string modName, IReadOnlySet<string> leftOut, IReadOnlyDictionary<string, string> provided);

    Stream OpenFile(string modFolder, string path);

    bool InstallationFileExists(string path);

    /// <summary>The name of the installation file at <paramref name="path"/>, without its folder.</summary>
    string InstallationFileName(string path);

    /// <summary>Every file's forward-slash path in <paramref name="modFolder"/>; none when it is not there.</summary>
    IReadOnlyList<string> FilePaths(string modFolder);

    /// <summary>The name of the mod folder at <paramref name="modFolder"/>, without the folder it is in.</summary>
    string FolderName(string modFolder);

    /// <summary>The forward-slash path relative to <paramref name="modFolder"/> of the file at <paramref name="file"/>.</summary>
    string PathIn(string modFolder, string file);

    /// <summary>Writes the file at <paramref name="path"/> under <paramref name="folder"/> from <paramref name="write"/>'s
    /// seekable stream. A throwing write, or the bytes already there, leave the folder as it was. True when it replaced
    /// other bytes.</summary>
    bool WriteFile(string folder, string path, Action<Stream> write);

    Stream OpenInstallationFile(string path);

    /// <summary>The game file at the forward-slash <paramref name="path"/> under <paramref name="dataFolder"/>.</summary>
    Stream OpenGameFile(string dataFolder, string path);

    /// <summary>Writes the mod's manifest into its folder, and only when its text differs from the one there.
    /// True when it wrote.</summary>
    bool WriteManifest(string modFolder, string modName, Manifest manifest);

    /// <summary>The mod's manifest, its files without stamps; null when its folder holds none. Throws
    /// <see cref="InvalidDataException"/> naming a line it cannot read.</summary>
    Manifest? ReadManifest(string modFolder, string modName);
}
