using MEditService.LoadOrder;
using MEditService.PluginAdapter;

namespace MEditService.RecordIndex.Queries;

// Only a plugin's own declared masters are consulted, never a master's masters
// (ADR-0012).
internal static class MasterResolution
{
    /// <summary>For each active plugin, its masters that are not active (MO2's <c>testMasters</c>)
    /// or load after it, matched by filename. A plugin with neither has no entry.</summary>
    public static IReadOnlyDictionary<PluginAddress, MasterProblems> Classify(
        LoadOrderSnapshot loadOrder, IReadOnlyDictionary<PluginAddress, PluginContent> opened)
    {
        var active = loadOrder.Active;
        var activeByName = active.ToDictionary(p => p.Name, p => p.Key, StringComparer.OrdinalIgnoreCase);

        var result = new Dictionary<PluginAddress, MasterProblems>(PluginAddress.Comparer);
        foreach (var key in active.Select(p => p.Key))
        {
            if (!opened.TryGetValue(key, out var content)) continue;
            var missing = content.Masters.Where(master => !activeByName.ContainsKey(master)).ToList();
            var late = content.Masters.Where(master => activeByName.TryGetValue(master, out var masterKey)
                && SameBlueprintClass(opened, content, masterKey)
                && loadOrder.LoadOrderIndex(masterKey) > loadOrder.LoadOrderIndex(key)).ToList();
            if (missing.Count + late.Count > 0) result[key] = new(missing, late);
        }
        return result;
    }

    // Master order holds only within one blueprint class; across the two, blueprint last decides
    // (plugins.md, Drag and drop, story 3). A master mEdit has not read counts as the same class.
    private static bool SameBlueprintClass(
        IReadOnlyDictionary<PluginAddress, PluginContent> opened, PluginContent plugin, PluginAddress master) =>
        !opened.TryGetValue(master, out var masterContent) || masterContent.IsBlueprint == plugin.IsBlueprint;
}

/// <summary>The masters of one plugin that the game cannot load it with.</summary>
internal sealed record MasterProblems(IReadOnlyList<string> Missing, IReadOnlyList<string> Late)
{
    public static readonly MasterProblems None = new([], []);
}
