using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.TestSupport;

/// <summary>What Mod Management would send for a fixture's entries: every plugin, the active ones —
/// the winning plugin of each enabled line, in line order — and those loaded with no line.</summary>
public static class SnapshotPlugins
{
    public static IReadOnlyList<RegisteredPlugin> Of(IEnumerable<LoadOrderEntry> entries) =>
        [.. entries.Select(entry => new RegisteredPlugin(
            entry.Name, entry.Origin, entry.Path, entry.Provider, entry.Line is { } line ? new PluginLine(line, entry.Winning) : null, entry.Strings))];

    public static IReadOnlyList<PluginAddress> Active(IEnumerable<LoadOrderEntry> entries) =>
        [.. entries.Where(entry => entry.Enabled && entry.Winning && entry.Line is not null)
            .OrderBy(entry => entry.Line)
            .Select(entry => entry.Key)];

    public static IReadOnlyList<PluginAddress> LoadedWithNoLine(IEnumerable<LoadOrderEntry> entries) =>
        [.. entries.Where(entry => entry.LoadedWithNoLine).Select(entry => entry.Key)];

    public static LoadOrderSnapshot Snapshot(
        string dataFolder, string? instanceRoot, GameRelease gameRelease, IEnumerable<LoadOrderEntry> entries,
        IReadOnlyList<PluginPlace>? places = null, Language stringsLanguage = Language.English)
    {
        var list = entries.ToList();
        return new LoadOrderSnapshot(dataFolder, instanceRoot, gameRelease, Of(list), Active(list), LoadedWithNoLine(list), [], [], places ?? [], stringsLanguage);
    }

    /// <summary>The PUT /load-order body.</summary>
    public static Dictionary<string, object> Body(
        string dataFolder, string instanceRoot, IEnumerable<LoadOrderEntry> entries, string gameRelease = "Fallout4",
        object? places = null, string stringsLanguage = "English")
    {
        var list = entries.ToList();
        return new()
        {
            ["dataFolder"] = dataFolder,
            ["instanceRoot"] = instanceRoot,
            ["plugins"] = list.Select(p => p.Wire),
            ["active"] = Active(list),
            ["loadedWithNoLine"] = LoadedWithNoLine(list),
            ["archives"] = Array.Empty<string>(),
            ["stringsFiles"] = Array.Empty<string>(),
            ["places"] = places ?? Array.Empty<object>(),
            ["gameRelease"] = gameRelease,
            ["stringsLanguage"] = stringsLanguage,
        };
    }
}
