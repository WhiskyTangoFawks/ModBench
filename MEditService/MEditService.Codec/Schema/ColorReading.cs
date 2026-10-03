using System.Drawing;
using System.Globalization;
using Noggog;

namespace MEditService.Codec.Schema;

/// <summary>A colour as the components it holds, in the codec's hex spelling: <c>#AARRGGBB</c>, or
/// <c>#RRGGBB</c> for one whose binary form holds no alpha (editor-fields.md, By type).</summary>
public static class ColorReading
{
    public const string ApiType = "color";

    /// <summary>Whether the text spells an alpha other than the 00 Mutagen's binary read gives a colour
    /// that holds none.</summary>
    public static bool SpellsAlpha(string text)
    {
        var hex = text.StartsWith('#') ? text[1..] : text;
        return hex.Length == 8
            && byte.TryParse(hex.AsSpan(0, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var alpha)
            && alpha != 0;
    }

    public static string Of(string text, bool holdsAlpha)
    {
        var alpha = holdsAlpha ? ColorExt.IncludeAlpha.Always : ColorExt.IncludeAlpha.Never;
        return Parsed(text) is { } color ? color.ToHexString(alpha) : text;
    }

    /// <summary>A colour that holds no alpha as Mutagen's binary read spells it: alpha 00.</summary>
    public static string AsReadWithoutAlpha(string text) =>
        Parsed(text) is { } color ? Color.FromArgb(0, color).ToHexString(ColorExt.IncludeAlpha.Always) : text;

    private static Color? Parsed(string text)
    {
        try
        {
            return ColorExt.FromHexString(text);
        }
        catch (Exception ex) when (ex is ArgumentException or FormatException)
        {
            return null;
        }
    }
}
