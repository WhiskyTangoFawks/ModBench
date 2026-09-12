using Noggog;

namespace MEditService.Codec.Schema;

/// <summary>A byte blob as hex text in Mutagen's own grammar (<c>WriteBytes</c>): "0x" plus uppercase
/// hex, "[]" empty, "" absent.</summary>
public static class ByteSliceHex
{
    public const string HexApiType = "hex";

    /// <summary>Mutagen's own <c>WriteBytes</c> spelling of a slice: <c>"[]"</c> when empty, else
    /// "0x" and uppercase hex.</summary>
    internal static string ToHex(ReadOnlySpan<byte> bytes) =>
        bytes.IsEmpty ? "[]" : "0x" + Convert.ToHexString(bytes);

    internal static bool IsByteSlice(Type core) =>
        core.IsGenericType
        && core.GetGenericTypeDefinition() == typeof(ReadOnlyMemorySlice<>)
        && core.GetGenericArguments()[0] == typeof(byte);

    /// <summary>Hex, with an optional <c>0x</c> prefix, or Mutagen's <c>"[]"</c> for an empty
    /// slice. Odd-length and non-hex text have no byte reading and decline here rather than being
    /// silently truncated to one.</summary>
    public static bool TryParseHex(string text, out byte[] bytes)
    {
        if (text == "[]") { bytes = []; return true; }

        var span = text.AsSpan();
        if (span.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) span = span[2..];
        try
        {
            bytes = Convert.FromHexString(span);
            return true;
        }
        catch (FormatException)
        {
            bytes = [];
            return false;
        }
    }
}
