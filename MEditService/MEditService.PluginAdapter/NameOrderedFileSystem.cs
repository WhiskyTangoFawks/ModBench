using System.IO.Abstractions;

namespace MEditService.PluginAdapter;

// Mutagen's serialization reads a group's records in the order a directory lists their files. NTFS
// lists by name and ext4 by a hash of the name, so the listing is put in name order everywhere.
internal sealed class NameOrderedFileSystem : FileSystem
{
    internal static readonly NameOrderedFileSystem Instance = new();

    private NameOrderedFileSystem() => Directory = new NameOrderedDirectory(this);

    public override IDirectory Directory { get; }

    private sealed class NameOrderedDirectory(IFileSystem fileSystem) : DirectoryWrapper(fileSystem)
    {
        public override string[] GetFiles(string path) => InNameOrder(base.GetFiles(path));

        public override string[] GetDirectories(string path) => InNameOrder(base.GetDirectories(path));

        private static string[] InNameOrder(string[] paths)
        {
            Array.Sort(paths, StringComparer.OrdinalIgnoreCase);
            return paths;
        }
    }
}
