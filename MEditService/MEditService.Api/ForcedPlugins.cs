using MEditService.Core.Plugins;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Order;

namespace MEditService.Api;

/// <summary>The plugins an install loads with no plugins.txt line of their own (ADR-0044). The one
/// place a game directory is read for them: the load-order snapshot and the implicit-masters
/// answer both come from here.</summary>
public static class ForcedPlugins
{
    /// <summary>The release's implicit masters present in <paramref name="gameDirectory"/>, then
    /// that folder's Creation Club catalog, which varies per install. Load order, and a name both
    /// sources claim appears once.</summary>
    public static IReadOnlyList<string> Names(string gameDirectory, GameRelease gameRelease) =>
        [.. ImplicitNames(gameDirectory, gameRelease)
            .Concat(CreationClubNames(gameDirectory, gameRelease))
            .Distinct(StringComparer.OrdinalIgnoreCase)];

    /// <summary>The snapshot as the load order registers it: the forced plugins first, forced on,
    /// and every entry slot offset past them. An entry naming a forced plugin is dropped, so that
    /// name is registered once.</summary>
    public static IReadOnlyList<RegisteredCopy> Prepend(
        string gameDirectory, GameRelease gameRelease, IReadOnlyList<LoadOrderEntry> entries)
    {
        var names = Names(gameDirectory, gameRelease);
        var forcedNames = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);

        var forced = names
            .Select((name, i) => new RegisteredCopy(
                name, PluginOrigin.DataDirectory, Path.Combine(gameDirectory, name), i, Enabled: true,
                Winning: true, IsForced: true))
            .ToList();

        return
        [
            .. forced,
            .. entries
                .Where(e => !forcedNames.Contains(e.Name))
                .Select(e => RegisteredCopy.Of(e, slotOffset: forced.Count)),
        ];
    }

    private static List<string> ImplicitNames(string folder, GameRelease gameRelease) =>
        [.. Implicits.Get(gameRelease).Listings
            .Select(k => k.FileName.ToString())
            .Where(name => File.Exists(Path.Combine(folder, name)))];

    // Mutagen's reader already filters to entries whose file exists, so a stale catalog entry
    // contributes nothing. Existence is checked first because LoadOrderListingsFromPath throws on a
    // missing file. Order is the catalog's own, never re-sorted.
    private static List<string> CreationClubNames(string folder, GameRelease gameRelease)
    {
        var cccPath = CreationClubListings.GetListingsPath(gameRelease.ToCategory(), folder);
        if (cccPath is not { } path || !File.Exists(path.Path)) return [];

        return CreationClubListings.LoadOrderListingsFromPath(path, folder)
            .Select(l => l.FileName.ToString())
            .ToList();
    }
}
