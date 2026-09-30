using MEditService.LoadOrder;
using Mutagen.Bethesda;

namespace MEditService.TestSupport;

/// <summary>What Mod Management would send for a fixture's entries: every plugin, and the active
/// ones — the winning plugin of each enabled line, in line order.</summary>
public static class SnapshotPlugins
{
    public static IReadOnlyList<RegisteredPlugin> Of(IEnumerable<LoadOrderEntry> entries) =>
        [.. entries.Select(entry => new RegisteredPlugin(entry.Name, entry.Origin, entry.Path))];

    public static IReadOnlyList<PluginAddress> Active(IEnumerable<LoadOrderEntry> entries) =>
        [.. entries.Where(entry => entry.Enabled && entry.Winning && entry.Slot is not null)
            .OrderBy(entry => entry.Slot)
            .Select(entry => entry.Key)];

    public static LoadOrderSnapshot Snapshot(
        string dataFolder, string? instanceRoot, GameRelease gameRelease, IEnumerable<LoadOrderEntry> entries)
    {
        var list = entries.ToList();
        return new LoadOrderSnapshot(dataFolder, instanceRoot, gameRelease, Of(list), Active(list));
    }

    /// <summary>The PUT /load-order body.</summary>
    public static object Body(
        string gameDirectory, string instanceRoot, IEnumerable<LoadOrderEntry> entries, string gameRelease = "Fallout4")
    {
        var list = entries.ToList();
        return new
        {
            gameDirectory,
            instanceRoot,
            plugins = list.Select(p => new { p.Name, p.Path, p.Origin }),
            active = Active(list),
            gameRelease,
        };
    }
}
