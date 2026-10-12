using System.Text;
using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

public sealed class ModFolderRepository : IModFolderRepository
{
    private const string ManifestExtension = ".manifest";

    public IReadOnlyList<StampedFile> Files(string modFolder, string modName) =>
        [.. new DirectoryInfo(modFolder).EnumerateFiles("*", SearchOption.AllDirectories)
            .Select(file => new StampedFile(
                Path.GetRelativePath(modFolder, file.FullName).Replace('\\', '/'),
                FileStamp.Of(file.FullName)))
            .Where(file => file.Path != ManifestName(modName))];

    public StampedFile? InstallationFile(string path) => File.Exists(path) ? new(path, FileStamp.Of(path)) : null;

    public StampedFile? GameFile(string gameFolder, string path) => InstallationFile(Path.Combine(gameFolder, path));

    public string InstallationFileName(string path) => Path.GetFileName(path);

    public Stream OpenFile(string folder, string path) =>
        OpenInstallationFile(Path.Combine(folder, path));

    public Stream OpenInstallationFile(string path) =>
        new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);

    public bool WriteManifest(string modFolder, string modName, Manifest manifest)
    {
        var path = Path.Combine(modFolder, ManifestName(modName));
        var text = ManifestText.Of(manifest);
        if (File.Exists(path) && File.ReadAllText(path, Encoding.UTF8) == text) return false;

        File.WriteAllText(path, text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return true;
    }

    private static string ManifestName(string modName) => modName + ManifestExtension;
}
