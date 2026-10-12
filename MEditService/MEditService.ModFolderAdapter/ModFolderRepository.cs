namespace MEditService.ModFolderAdapter;

public sealed class ModFolderRepository : IModFolderRepository
{
    public IReadOnlyList<ModFile> Files(string modFolder) =>
        [.. new DirectoryInfo(modFolder).EnumerateFiles("*", SearchOption.AllDirectories)
            .Select(file => new ModFile(
                Path.GetRelativePath(modFolder, file.FullName).Replace('\\', '/'),
                file.Length,
                file.LastWriteTimeUtc))];

    public ModFile InstallationFile(string path)
    {
        var file = new FileInfo(path);
        return new ModFile(path, file.Length, file.LastWriteTimeUtc);
    }

    public Stream OpenFile(string modFolder, string path) =>
        OpenInstallationFile(Path.Combine(modFolder, path));

    public Stream OpenInstallationFile(string path) =>
        new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
}
