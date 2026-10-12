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

    public StampedFile? GameFile(string dataFolder, string path) => InstallationFile(Path.Combine(dataFolder, path));

    public string InstallationFileName(string path) => Path.GetFileName(path);

    public Stream OpenFile(string folder, string path) =>
        OpenInstallationFile(Path.Combine(folder, path));

    public Stream OpenInstallationFile(string path) =>
        new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);

    public void WriteFile(string folder, string path, Action<Stream> write)
    {
        var target = Path.Combine(folder, path);
        var partial = Path.Combine(folder, ".medit_tmp_" + Path.GetRandomFileName() + ".tmp");
        try
        {
            using (var content = new FileStream(partial, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
                write(content);
            Directory.CreateDirectory(Path.GetDirectoryName(target) ?? folder);
            File.Move(partial, target, overwrite: true);
        }
        finally
        {
            File.Delete(partial);
        }
    }

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
