namespace MEditService.ModFolderAdapter;

/// <summary>The one reader of a mod folder's files and of the installation files a mod was made from.</summary>
public interface IModFolderRepository
{
    /// <summary>Every file under <paramref name="modFolder"/>, by path relative to it with forward slashes.</summary>
    IReadOnlyList<ModFile> Files(string modFolder);

    /// <summary>The file at <paramref name="path"/>, described under that path.</summary>
    ModFile InstallationFile(string path);

    Stream OpenFile(string modFolder, string path);

    Stream OpenInstallationFile(string path);
}
