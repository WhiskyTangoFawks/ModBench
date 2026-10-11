using System.IO.Abstractions;

namespace MEditService.PluginAdapter;

// Mutagen's serialization orders a group's records and a block level's blocks as the directory lists
// them, and file systems list differently: NTFS by name, ext4 by a hash of the name.
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
