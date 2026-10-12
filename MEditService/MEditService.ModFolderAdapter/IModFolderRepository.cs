namespace MEditService.ModFolderAdapter;

/// <summary>The one reader of a mod folder's files, of the installation files a mod was made from and of the game
/// folder, and the one writer of a mod's manifest.</summary>
public interface IModFolderRepository
{
    /// <summary>Every file of the mod under <paramref name="modFolder"/> but its manifest, by path relative to the
    /// folder with forward slashes.</summary>
    IReadOnlyList<StampedFile> Files(string modFolder, string modName);

    /// <summary>The file at <paramref name="path"/>, described under that path; null when there is none.</summary>
    StampedFile? InstallationFile(string path);

    /// <summary>The file at <paramref name="path"/> under <paramref name="gameFolder"/>, described under that path;
    /// null when there is none.</summary>
    StampedFile? GameFile(string gameFolder, string path);

    /// <summary>The name of the installation file at <paramref name="path"/>, without its folder.</summary>
    string InstallationFileName(string path);

    Stream OpenFile(string folder, string path);

    Stream OpenInstallationFile(string path);

    /// <summary>Writes the mod's manifest into its folder, and only when its text differs from the one there.
    /// True when it wrote.</summary>
    bool WriteManifest(string modFolder, string modName, Manifest manifest);
}
