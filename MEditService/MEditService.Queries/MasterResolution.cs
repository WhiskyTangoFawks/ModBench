using MEditService.LoadOrder;

namespace MEditService.Queries;

// ADR-0012 invariant 4: only a plugin's own declared masters are consulted, never a master's
// masters, because a master issue never cascades.
internal static class MasterResolution
{
    /// <summary>For each active plugin, the masters in its header that are not active, as MO2's
    /// <c>PluginList::testMasters</c> finds them. A plugin with none has no entry.</summary>
    public static IReadOnlyDictionary<PluginAddress, IReadOnlyList<string>> Classify(
        LoadOrderSnapshot loadOrder, IReadOnlyDictionary<PluginAddress, PluginContent> opened)
    {
        var active = loadOrder.Participating;
        var activeNames = active.Select(p => p.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);

        var result = new Dictionary<PluginAddress, IReadOnlyList<string>>(PluginAddress.Comparer);
        foreach (var key in active.Select(p => p.Key))
        {
            if (!opened.TryGetValue(key, out var content)) continue;
            var inactive = content.Masters.Where(master => !activeNames.Contains(master)).ToList();
            if (inactive.Count > 0) result[key] = inactive;
        }
        return result;
    }
}
