using Noggog;

namespace MEditService.Codec.Schema;

/// <summary>A colour as the components it holds, in the codec's hex spelling: <c>#AARRGGBB</c>, or
/// <c>#RRGGBB</c> for one whose binary form holds no alpha (editor-fields.md, By type).</summary>
public static class ColorReading
{
    public const string ApiType = "color";

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
