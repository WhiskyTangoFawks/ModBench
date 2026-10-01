using System.Globalization;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries;

/// <summary>editor.md, A column's header: xEdit's load index, in hex. A plugin counts among the
/// active plugins of its own kind, full or light; a light one's follows the light marker.</summary>
internal static class LoadIndex
{
    private static bool IsLight(PluginAddress key, IReadOnlyDictionary<PluginAddress, PluginContent> opened) =>
        opened.TryGetValue(key, out var content) && content.IsLight;

    internal static string Of(
        PluginAddress plugin, int loadOrderIndex, LoadOrderSnapshot snapshot,
        IReadOnlyDictionary<PluginAddress, PluginContent> opened)
    {
        var light = IsLight(plugin, opened);
        var place = snapshot.Active.Take(loadOrderIndex).Count(active => IsLight(active.Key, opened) == light);
        return light ? $"{FormID.SmallMasterMarker:X2}:{place:X3}" : $"{place:X2}";
    }

    /// <summary>The FormKey a FormID names: the inverse of <see cref="Of"/>, read from the active
    /// plugins. Null when the text is no FormID or no active plugin holds that index.</summary>
    internal static FormKey? FormKeyOf(
        string text, LoadOrderSnapshot snapshot, IReadOnlyDictionary<PluginAddress, PluginContent> opened)
    {
        var digits = text.Trim();
        if (digits.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) digits = digits[2..];
        if (digits.Length != 8 || !uint.TryParse(digits, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var formId))
            return null;

        var light = formId >> 24 == FormID.SmallMasterMarker;
        var place = (int)(light ? (formId >> 12) & 0xFFF : formId >> 24);
        var id = formId & (light ? 0xFFFu : 0xFFFFFFu);
        var holder = snapshot.Active.Where(active => IsLight(active.Key, opened) == light).ElementAtOrDefault(place);
        return holder is null ? null : new FormKey(ModKey.FromFileName(holder.Key.Name), id);
    }
}
