using MEditService.LoadOrder;
using MEditService.PluginAdapter;

namespace MEditService.Index.Queries;

/// <summary>Master lists hold file names only (ADR-0012), so a plugin is matched by its file name,
/// without case, across every plugin the instance holds, active or not.</summary>
internal static class Dependants
{
    public static PluginDependants Of(
        PluginAddress plugin, LoadOrderSnapshot held, IReadOnlyDictionary<PluginAddress, PluginContent> opened)
    {
        var others = held.Plugins.Where(other => !PluginAddress.Comparer.Equals(other.Key, plugin)).ToList();
        return new PluginDependants(
            [.. others.Where(other => opened.TryGetValue(other.Key, out var content)
                && content.Masters.Contains(plugin.Name, StringComparer.OrdinalIgnoreCase)).Select(other => other.Key)],
            [.. others.Where(other => !opened.ContainsKey(other.Key)).Select(other => other.Key)]);
    }
}
