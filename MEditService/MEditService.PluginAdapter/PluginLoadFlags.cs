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

        return HashOf(bytes);
    }

    /// <summary>The hash of the plugin with each named flag at each combination of original values; none unless the plugin
    /// holds each named flag as <paramref name="flags"/> sets it, and none for a file that is no plugin.</summary>
    internal static IReadOnlyList<string> OriginalHashes(string path, IReadOnlyDictionary<string, bool> flags, GameRelease gameRelease)
    {
        var load = GameCodecs.For(gameRelease).LoadFlags;
        var bytes = File.ReadAllBytes(path);
        var constants = GameConstants.Get(gameRelease);
        if (bytes.Length < constants.ModHeaderLength) return [];
        var header = new ModHeader(constants, bytes);
        if (header.RecordType.Type != "TES4") return [];

        if (flags.Any(flag => (header.Flags & load[flag.Key]) == load[flag.Key] != flag.Value)) return [];

        var named = flags.Keys.Select(name => load[name]).ToArray();
        var cleared = named.Aggregate(header.Flags, (set, mask) => set & ~mask);
        var hashes = new HashSet<string>();
        for (var combination = 0; combination < 1 << named.Length; combination++)
        {
            var original = cleared;
            for (var i = 0; i < named.Length; i++)
                if ((combination & (1 << i)) != 0) original |= named[i];
            BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(FlagsAt, FlagsLength), original);
            hashes.Add(HashOf(bytes));
        }

        return [.. hashes];
    }

    private static string HashOf(byte[] bytes)
    {
        Span<byte> digest = stackalloc byte[sizeof(ulong)];
        BinaryPrimitives.WriteUInt64LittleEndian(digest, XxHash64.HashToUInt64(bytes));
        return Convert.ToBase64String(digest);
    }
}
