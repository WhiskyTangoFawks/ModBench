using MEditService.LoadOrder;
using MEditService.PluginAdapter;

namespace MEditService.RecordIndex.Queries;

// Only a plugin's own declared masters are consulted, never a master's masters
// (ADR-0012).
internal static class MasterResolution
{
    /// <summary>For each active plugin, the masters in its header that are not active, as MO2's
    /// <c>PluginList::testMasters</c> finds them, and those that are active but load after it. A
    /// plugin with neither has no entry. A header names a master by filename, so the match is by
    /// filename among the active plugins, which hold one file per name.</summary>
    public static IReadOnlyDictionary<PluginAddress, MasterProblems> Classify(
        LoadOrderSnapshot loadOrder, IReadOnlyDictionary<PluginAddress, PluginContent> opened)
    {
        var active = loadOrder.Active;
        var placeOfName = active
            .GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => loadOrder.LoadOrderIndex(g.First().Key), StringComparer.OrdinalIgnoreCase);

        var result = new Dictionary<PluginAddress, MasterProblems>(PluginAddress.Comparer);
        foreach (var key in active.Select(p => p.Key))
        {
            if (!opened.TryGetValue(key, out var content)) continue;
            var own = loadOrder.LoadOrderIndex(key);
            var inactive = content.Masters.Where(master => !placeOfName.ContainsKey(master)).ToList();
            var late = content.Masters.Where(master => placeOfName.TryGetValue(master, out var place) && place > own).ToList();
            if (inactive.Count + late.Count > 0) result[key] = new(inactive, late);
        }
        return result;
    }
}

/// <summary>The masters of one plugin that the game cannot load it with.</summary>
internal sealed record MasterProblems(IReadOnlyList<string> Inactive, IReadOnlyList<string> LoadAfter)
{
    public static readonly MasterProblems None = new([], []);
}
