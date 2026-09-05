using System.Drawing;
using System.Globalization;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Schema;

/// <summary>A CLR value type Loqui does not model, spelled by the codec as one text leaf. One entry:
/// System.Drawing.Color, written as "#AARRGGBB".</summary>
internal static class AtomicValueLeaves
{
    // Six digits is an RGB edit that keeps the existing alpha byte; eight names all four. Only an
    // alpha-bearing field (xEdit's wbByteRGBA) takes the posted alpha: any other color's fourth byte
    // is wbUnused.
    internal static Func<object, JsonElement, ApplyOutcome> MakeColorApplier(string pName, bool hasAlpha, ILogger logger)
    {
        var resolve = LeafWriters.ResolveProperty(pName);
        return (obj, val) =>
        {
            var rp = resolve(obj.GetType());
            if (rp == null) return ApplyOutcome.PropertyNotFound;
            if (val.ValueKind != JsonValueKind.String || !TryParseHex(val.GetString()!, out var argb, out var namesAlpha))
                return ApplyOutcome.ValueRejected;

            var existing = rp.GetValue(obj) as Color?;
            var alpha = namesAlpha && hasAlpha ? argb.A : existing?.A ?? 0;
            return LeafWriters.SetOrDecline(rp, obj, Color.FromArgb(alpha, argb.R, argb.G, argb.B), pName, logger);
        };
    }

    private static bool TryParseHex(string text, out Color color, out bool namesAlpha)
    {
        color = default;
        namesAlpha = false;
        var digits = text.StartsWith('#') ? text[1..] : text;
        if (digits.Length is not (6 or 8) || !uint.TryParse(digits, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var value))
            return false;
        namesAlpha = digits.Length == 8;
        color = Color.FromArgb(namesAlpha ? unchecked((int)value) : unchecked((int)(0xFF000000 | value)));
        return true;
    }
}
