using System.Text.Json;

namespace MEditService.Codec.Schema;

/// <summary>The read side of a synthetic member: whether its bit is set in the member the
/// document spells, a raw integer or an array of flag names.</summary>
public static class SyntheticBits
{
    public static bool IsSet(JsonElement root, SyntheticBit bit) =>
        DocumentNodes.At(root, bit.BackingPath) switch
        {
            { ValueKind: JsonValueKind.Number } raw => (raw.GetInt64() & bit.Bit) != 0,
            { ValueKind: JsonValueKind.Array } names => names.EnumerateArray().Any(n => n.GetString() == bit.FlagName),
            _ => false,
        };
}
