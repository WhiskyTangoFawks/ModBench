using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;

namespace MEditService.Queries;

/// <summary>The plugins whose masters list a plugin's file name, and those whose masters mEdit could not
/// read and so may.</summary>
public sealed record PluginDependants(IReadOnlyList<PluginAddress> Plugins, IReadOnlyList<PluginAddress> Unreadable);

/// <summary>Master lists hold file names only (ADR-0012), so a plugin is matched by its file name,
/// without case, across every plugin the instance holds, active or not.</summary>
public sealed class PluginDependantsQueryService(IQueryIndex index, LoadOrderHolder loadOrder)
{
    /// <summary>Null until the index is ready: a plugin it has not opened would read as no dependant.</summary>
    public PluginDependants? GetDependants(PluginAddress plugin)
    {
        var reads = index.RequireReads();
        var held = loadOrder.Require();
        if (index.Status.State != LoadOrderState.Ready) return null;

        var opened = reads.OpenedPlugins;
        var others = held.Plugins.Where(other => !PluginAddress.Comparer.Equals(other.Key, plugin)).ToList();
        return new PluginDependants(
            [.. others.Where(other => opened.TryGetValue(other.Key, out var content)
                && content.Masters.Contains(plugin.Name, StringComparer.OrdinalIgnoreCase)).Select(other => other.Key)],
            [.. others.Where(other => !opened.ContainsKey(other.Key)).Select(other => other.Key)]);
    }
}
