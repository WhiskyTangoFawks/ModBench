using System.Buffers.Binary;
using System.IO.Hashing;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Binary.Headers;
using Mutagen.Bethesda.Plugins.Meta;

namespace MEditService.PluginAdapter;

/// <summary>A plugin's bytes with some of its load flags flipped: the values those flags then hold, and the xxHash64 of the
/// bytes, its eight bytes little-endian in base64, as a manifest carries it.</summary>
public sealed record FlagVariant(IReadOnlyDictionary<string, bool> Flags, string Hash);

/// <summary>A plugin's load flags, which Mutagen's ModHeader reads from the four bytes after its type and length.</summary>
internal static class LoadFlagVariants
{
    private const int FlagsAt = 8;
    private const int FlagsLength = 4;

    internal static IReadOnlyList<FlagVariant> Of(string path, GameRelease gameRelease)
    {
        var bytes = File.ReadAllBytes(path);
        var held = HeldFlags(bytes, gameRelease);
        var load = GameCodecs.For(gameRelease).LoadFlags.OrderBy(flag => flag.Value).ToArray();
        return [.. Enumerable.Range(1, (1 << load.Length) - 1)
            .OrderBy(flipped => int.PopCount(flipped)).ThenBy(flipped => flipped)
            .Select(flipped =>
            {
                var chosen = load.Where((_, at) => (flipped & (1 << at)) != 0).ToArray();
                var flags = held ^ chosen.Aggregate(0, (bits, flag) => bits | flag.Value);
                return new FlagVariant(chosen.ToDictionary(flag => flag.Key, flag => (flags & flag.Value) != 0), HashWith(bytes, flags));
            })];
    }

    /// <summary>Writes the plugin with each flag of <paramref name="flags"/> set or cleared and every other byte as it was, and
    /// answers the hash of what it wrote.</summary>
    internal static string Set(string path, IReadOnlyDictionary<string, bool> flags, GameRelease gameRelease)
    {
        var load = GameCodecs.For(gameRelease).LoadFlags;
        var bytes = File.ReadAllBytes(path);
        var set = HeldFlags(bytes, gameRelease);
        foreach (var (name, on) in flags)
            set = on ? set | load[name] : set & ~load[name];
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(FlagsAt, FlagsLength), set);

        var temp = $"{path}.medit_tmp_{Environment.ProcessId}_flags";
        try
        {
            File.WriteAllBytes(temp, bytes);
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            File.Delete(temp);
        }

        return HashWith(bytes, set);
    }

    private static int HeldFlags(byte[] bytes, GameRelease gameRelease)
    {
        var header = new ModHeader(GameConstants.Get(gameRelease), bytes);
        return header.RecordType.Type == "TES4"
            ? header.Flags
            : throw new InvalidDataException($"It does not start with a plugin header: it starts with {header.RecordType}.");
    }

    private static string HashWith(byte[] bytes, int flags)
    {
        var hash = new XxHash64();
        hash.Append(bytes.AsSpan(0, FlagsAt));
        Span<byte> word = stackalloc byte[FlagsLength];
        BinaryPrimitives.WriteInt32LittleEndian(word, flags);
        hash.Append(word);
        hash.Append(bytes.AsSpan(FlagsAt + FlagsLength));
        Span<byte> digest = stackalloc byte[sizeof(ulong)];
        BinaryPrimitives.WriteUInt64LittleEndian(digest, hash.GetCurrentHashAsUInt64());
        return Convert.ToBase64String(digest);
    }
}
