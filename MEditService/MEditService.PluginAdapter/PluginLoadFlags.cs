using System.Buffers.Binary;
using System.IO.Hashing;
using MEditService.Codec.Serialization;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Binary.Headers;
using Mutagen.Bethesda.Plugins.Meta;

namespace MEditService.PluginAdapter;

/// <summary>A plugin's load flags, which Mutagen's ModHeader reads from the four bytes after its type and length.</summary>
internal static class PluginLoadFlags
{
    private const int FlagsAt = 8;
    private const int FlagsLength = 4;

    /// <summary>Writes the plugin with each flag set or cleared and every other byte as it was, and answers the xxHash64 of
    /// what it wrote, as a manifest carries it.</summary>
    internal static string Set(string path, IReadOnlyDictionary<string, bool> flags, GameRelease gameRelease)
    {
        var load = GameCodecs.For(gameRelease).LoadFlags;
        var bytes = File.ReadAllBytes(path);
        var header = new ModHeader(GameConstants.Get(gameRelease), bytes);
        if (header.RecordType.Type != "TES4")
            throw new InvalidDataException($"It does not start with a plugin header: it starts with {header.RecordType}.");

        var set = header.Flags;
        foreach (var (name, on) in flags)
            set = on ? set | load[name] : set & ~load[name];
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(FlagsAt, FlagsLength), set);

        var folder = Path.GetDirectoryName(path) ?? ".";
        TempName.RemoveLeftovers(folder);
        var temp = TempName.FileIn(folder);
        try
        {
            File.WriteAllBytes(temp, bytes);
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            File.Delete(temp);
        }

        Span<byte> digest = stackalloc byte[sizeof(ulong)];
        BinaryPrimitives.WriteUInt64LittleEndian(digest, XxHash64.HashToUInt64(bytes));
        return Convert.ToBase64String(digest);
    }
}
