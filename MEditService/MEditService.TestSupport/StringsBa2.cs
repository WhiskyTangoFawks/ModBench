using System.Text;

namespace MEditService.TestSupport;

/// <summary>A Fallout 4 general archive (BA2 version 1) holding strings files under <c>Strings</c>,
/// uncompressed and unhashed: Mutagen's reader finds a file by the name table.</summary>
public static class StringsBa2
{
    private const int HeaderLength = 24;
    private const int EntryLength = 36;
    private const uint Unaligned = 0xBAADF00D;

    public static void Pack(IEnumerable<string> stringsFiles, string archivePath)
    {
        var files = stringsFiles
            .Select(path => (Name: Encoding.UTF8.GetBytes($"Strings\\{Path.GetFileName(path)}"), Content: File.ReadAllBytes(path)))
            .ToList();
        var dataStart = HeaderLength + (files.Count * EntryLength);
        var nameTableOffset = dataStart + files.Sum(f => f.Content.Length);

        using var writer = new BinaryWriter(File.Create(archivePath));
        writer.Write(Encoding.ASCII.GetBytes("BTDX"));
        writer.Write(1u);
        writer.Write(Encoding.ASCII.GetBytes("GNRL"));
        writer.Write((uint)files.Count);
        writer.Write((ulong)nameTableOffset);

        var offset = dataStart;
        foreach (var (_, content) in files)
        {
            writer.Write(0u);
            writer.Write(Encoding.ASCII.GetBytes("strs"));
            writer.Write(0u);
            writer.Write(0u);
            writer.Write((ulong)offset);
            writer.Write(0u);
            writer.Write((uint)content.Length);
            writer.Write(Unaligned);
            offset += content.Length;
        }
        foreach (var (_, content) in files) writer.Write(content);
        foreach (var (name, _) in files)
        {
            writer.Write((short)name.Length);
            writer.Write(name);
        }
    }
}
