using System.IO.Abstractions;

namespace MEditService.Codec.Serialization;

// The door creates its target directory through SerializationMetaData.FileSystem rather than the
// stream creator, so redirecting streams alone still leaves directories on disk.
internal sealed class NoRecordFolders : FileSystem
{
    internal static readonly NoRecordFolders Instance = new();

    private readonly Lazy<IDirectory> _directory;

    private NoRecordFolders() => _directory = new Lazy<IDirectory>(() => new NonCreatingDirectory(this));

    public override IDirectory Directory => _directory.Value;

    private sealed class NonCreatingDirectory(IFileSystem fileSystem) : DirectoryWrapper(fileSystem)
    {
        public override IDirectoryInfo CreateDirectory(string path) => FileSystem.DirectoryInfo.New(path);
    }
}
