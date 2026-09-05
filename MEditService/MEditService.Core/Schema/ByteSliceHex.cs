using System.Text.Json;
using Microsoft.Extensions.Logging;
using Noggog;

namespace MEditService.Core.Schema;

/// <summary>A byte blob as hex text in Mutagen's own grammar (<c>WriteBytes</c>): "0x" plus uppercase
/// hex, "[]" empty, "" absent.</summary>
internal static class ByteSliceHex
{
    internal const string HexApiType = "hex";

    internal static bool IsByteSlice(Type core) =>
        core.IsGenericType
        && core.GetGenericTypeDefinition() == typeof(ReadOnlyMemorySlice<>)
        && core.GetGenericArguments()[0] == typeof(byte);

    /// <summary>Hex, with an optional <c>0x</c> prefix, or Mutagen's <c>"[]"</c> for an empty
    /// slice. Odd-length and non-hex text have no byte reading and decline here rather than being
    /// silently truncated to one.</summary>
    internal static bool TryParseHex(string text, out byte[] bytes)
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

    // Null and "" both spell "no slice" in Mutagen's byte-text grammar.
    private static bool IsAbsentSlice(JsonElement val) =>
        val.ValueKind == JsonValueKind.Null || (val.ValueKind == JsonValueKind.String && val.GetString()!.Length == 0);

    // Nothing here can know which bytes a resize would move, so a size change is refused; an absent or
    // empty slice has no established size and accepts any.
    private static bool ResizeRefused(object? existing, int newLength) => existing switch
    {
        null => false,
        MemorySlice<byte> slice => slice.Length > 0 && slice.Length != newLength,
        _ => true,
    };

    internal static Func<object, JsonElement, ApplyOutcome> MakeHexApplier(string pName, bool nullable, ILogger logger)
    {
        var resolve = LeafWriters.ResolveProperty(pName);
        return (obj, val) =>
        {
            var rp = resolve(obj.GetType());
            if (rp == null) return ApplyOutcome.PropertyNotFound;

            if (IsAbsentSlice(val))
                return nullable ? LeafWriters.SetOrDecline(rp, obj, null, pName, logger) : ApplyOutcome.ValueRejected;

            if (val.ValueKind != JsonValueKind.String) return ApplyOutcome.ValueRejected;
            if (!TryParseHex(val.GetString()!, out var bytes)) return ApplyOutcome.ValueRejected;
            if (ResizeRefused(rp.GetValue(obj), bytes.Length)) return ApplyOutcome.ValueRejected;

            return LeafWriters.SetOrDecline(rp, obj, new MemorySlice<byte>(bytes), pName, logger);
        };
    }
}
