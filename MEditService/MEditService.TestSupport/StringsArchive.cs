using System.Text;

namespace MEditService.TestSupport;

/// <summary>A Skyrim SE archive (BSA version 105) holding strings files under <c>strings</c> in the order
/// given, as a Creation Club plugin ships its strings. Uncompressed and unhashed: Mutagen's reader finds
/// a file by its name.</summary>
public static class StringsArchive
{
    private const int HeaderLength = 36;
    private const int FolderRecordLength = 24;
    private const int FileRecordLength = 16;
    private const uint SkyrimSpecialEdition = 105;
    private const uint FolderAndFileNames = 0x1 | 0x2;
    private static readonly byte[] Folder = Encoding.ASCII.GetBytes("strings\0");

    public static void Pack(IEnumerable<string> stringsFiles, string archivePath)
    {
        var files = stringsFiles
            .Select(path => (Name: Encoding.ASCII.GetBytes(Path.GetFileName(path).ToLowerInvariant() + "\0"), Content: File.ReadAllBytes(path)))
            .ToList();
        var fileNamesLength = files.Sum(f => f.Name.Length);
        var dataStart = HeaderLength + FolderRecordLength + 1 + Folder.Length + (files.Count * FileRecordLength) + fileNamesLength;

        using var writer = new BinaryWriter(File.Create(archivePath));
        writer.Write(Encoding.ASCII.GetBytes("BSA\0"));
        writer.Write(SkyrimSpecialEdition);
        writer.Write((uint)HeaderLength);
        writer.Write(FolderAndFileNames);
        writer.Write(1u);
        writer.Write((uint)files.Count);
        writer.Write((uint)Folder.Length);
        writer.Write((uint)fileNamesLength);
        writer.Write(0u);

        writer.Write(0ul);
        writer.Write((uint)files.Count);
        writer.Write(0u);
        writer.Write((ulong)(HeaderLength + FolderRecordLength + fileNamesLength));

        writer.Write((byte)Folder.Length);
        writer.Write(Folder);
        var offset = dataStart;
        foreach (var (_, content) in files)
        {
            writer.Write(0ul);
            writer.Write((uint)content.Length);
            writer.Write((uint)offset);
            offset += content.Length;
        }
        foreach (var (name, _) in files) writer.Write(name);
        foreach (var (_, content) in files) writer.Write(content);
    }
}
