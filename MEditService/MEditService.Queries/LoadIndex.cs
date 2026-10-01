using MEditService.LoadOrder;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries;

/// <summary>editor.md, A column's header: xEdit's load index, in hex. A plugin counts among the
/// active plugins of its own kind, full or light; a light one's follows the light marker.</summary>
internal static class LoadIndex
{
    internal static string Of(
        PluginAddress plugin, int loadOrderIndex, LoadOrderSnapshot snapshot,
        IReadOnlyDictionary<PluginAddress, PluginContent> opened)
    {
        bool IsLight(PluginAddress key) => opened.TryGetValue(key, out var content) && content.IsLight;
        var light = IsLight(plugin);
        var place = snapshot.Active.Take(loadOrderIndex).Count(active => IsLight(active.Key) == light);
        return light ? $"{FormID.SmallMasterMarker:X2}:{place:X3}" : $"{place:X2}";
    }
}
