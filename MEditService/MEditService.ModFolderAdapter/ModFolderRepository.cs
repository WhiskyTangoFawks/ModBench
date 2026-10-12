using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

public sealed class ModFolderRepository : IModFolderRepository
{
    public IReadOnlyList<ModFile> Files(string modFolder) =>
        [.. new DirectoryInfo(modFolder).EnumerateFiles("*", SearchOption.AllDirectories)
            .Select(file => new ModFile(
                Path.GetRelativePath(modFolder, file.FullName).Replace('\\', '/'),
                FileStamp.Of(file.FullName)))];

    public ModFile InstallationFile(string path) => new(path, FileStamp.Of(path));

    public Stream OpenFile(string modFolder, string path) =>
        OpenInstallationFile(Path.Combine(modFolder, path));

    public Stream OpenInstallationFile(string path) =>
        new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
}
