using System.Text.Json;
using MEditService.Codec.Serialization;

namespace MEditService.Codec.Schema;

/// <summary>The read side of a synthetic member: whether its flag is among the names the document
/// spells for its flags member.</summary>
public static class SyntheticBits
{
    public static bool IsSet(Document document, SyntheticBit bit) =>
        document.At(bit.BackingPath.Split('.')) is { ValueKind: JsonValueKind.Array } names
        && names.EnumerateArray().Any(n => n.GetString() == bit.FlagName);

    internal static bool IsSet(JsonElement root, SyntheticBit bit) => Document.Over(root) is { } document && IsSet(document, bit);
}
