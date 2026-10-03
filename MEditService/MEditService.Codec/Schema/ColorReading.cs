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

    /// <summary>Text with no colour reading is its own.</summary>
    public static string Of(string text, bool holdsAlpha)
    {
        try
        {
            return ColorExt.FromHexString(text).ToHexString(holdsAlpha ? ColorExt.IncludeAlpha.Always : ColorExt.IncludeAlpha.Never);
        }
        catch (Exception ex) when (ex is ArgumentException or FormatException)
        {
            return text;
        }
    }
}
