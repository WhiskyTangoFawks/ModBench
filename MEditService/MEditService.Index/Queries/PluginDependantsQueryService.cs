using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.Index.Queries;

/// <summary>The plugins whose masters list a plugin's file name, and those whose masters mEdit could not
/// read and so may.</summary>
public sealed record PluginDependants(IReadOnlyList<PluginAddress> Plugins, IReadOnlyList<PluginAddress> Unreadable);

/// <summary>Master lists hold file names only (ADR-0012), so a plugin is matched by its file name,
/// without case, across every plugin the instance holds, active or not.</summary>
public sealed class PluginDependantsQueryService
{
    private readonly IQueryIndex _index;
    private readonly LoadOrderHolder _loadOrder;

    internal PluginDependantsQueryService(IQueryIndex index, LoadOrderHolder loadOrder)
    {
        _index = index;
        _loadOrder = loadOrder;
    }

    /// <summary>A plugin the index has not opened would read as no dependant.</summary>
    public Answer<PluginDependants, IndexRefused> GetDependants(PluginAddress plugin) => IndexAnswer.Of(() => DependantsOf(plugin));

    private PluginDependants DependantsOf(PluginAddress plugin)
    {
        var held = _loadOrder.Require();
        var opened = _index.RequireWholeSetReads().OpenedPlugins;
        var others = held.Plugins.Where(other => !PluginAddress.Comparer.Equals(other.Key, plugin)).ToList();
        return new PluginDependants(
            [.. others.Where(other => opened.TryGetValue(other.Key, out var content)
                && content.Masters.Contains(plugin.Name, StringComparer.OrdinalIgnoreCase)).Select(other => other.Key)],
            [.. others.Where(other => !opened.ContainsKey(other.Key)).Select(other => other.Key)]);
    }
}
