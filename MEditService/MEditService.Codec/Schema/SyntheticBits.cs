using System.Text.Json;

namespace MEditService.Codec.Schema;

/// <summary>The read side of a synthetic member: whether its flag is among the names the document
/// spells for its flags member.</summary>
public static class SyntheticBits
{
    public static bool IsSet(JsonElement root, SyntheticBit bit) =>
        DocumentNodes.At(root, bit.BackingPath) is { ValueKind: JsonValueKind.Array } names
        && names.EnumerateArray().Any(n => n.GetString() == bit.FlagName);
}
