using System.Text.Json;
using Microsoft.Extensions.Logging;
using Noggog;

namespace MEditService.Core.Schema;

/// <summary>A byte blob, rendered and read back as hex text (#690). The text form is Mutagen's own
/// (<c>NewtonsoftJsonSerializationWriterKernel.WriteBytes</c>): "0x" + uppercase hex, "[]" empty,
/// "" absent — reading and writing that exact grammar is what makes Extract and the generated
/// json_extract view answer the same string for the same record.</summary>
internal static class ByteSliceHex
{
    internal const string HexApiType = "hex";

    internal static bool IsByteSlice(Type core) =>
        core.IsGenericType
        && core.GetGenericTypeDefinition() == typeof(ReadOnlyMemorySlice<>)
        && core.GetGenericArguments()[0] == typeof(byte);

    // Both slice types, because which one arrives depends on which side of the record is in hand: a
    // getter overlay's list yields ReadOnlyMemorySlice, while a mutable record's SliceList<byte>
    // yields MemorySlice — and ArrayOpWriter reads a column's current value off the mutable record.
    internal static string? HexText(object? raw) => raw switch
    {
        ReadOnlyMemorySlice<byte> s => HexText(s.Span),
        MemorySlice<byte> s => HexText(s.Span),
        _ => null,
    };

    internal static string HexText(ReadOnlySpan<byte> bytes) =>
        bytes.Length == 0 ? "[]" : "0x" + Convert.ToHexString(bytes);

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

    /// <summary>Absent, in Mutagen's own byte-text grammar and in JSON: both spell "there is no
    /// slice here".</summary>
    private static bool IsAbsentSlice(JsonElement val) =>
        val.ValueKind == JsonValueKind.Null || (val.ValueKind == JsonValueKind.String && val.GetString()!.Length == 0);

    /// <summary>Whether writing <paramref name="newLength"/> bytes over <paramref name="existing"/>
    /// would resize the slice. Nothing here can read a blob's internal structure, so nothing here
    /// can know which bytes a resize would move. An absent or empty slice has no established size
    /// and accepts any; a property this applier cannot read a slice out of at all refuses rather
    /// than skipping the question.</summary>
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
