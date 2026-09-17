using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Order;

namespace MEditService.PluginAdapter;

/// <summary>The two sources an install loads a plugin from without a load-order line naming it
/// (ADR-0013): the release's own implicit masters, and the Creation Club catalog beside the game
/// directory, which varies per install.</summary>
internal static class ImplicitPlugins
{
    internal static IReadOnlyList<string> In(string dataFolder, GameRelease gameRelease) =>
        [.. ImplicitNames(dataFolder, gameRelease)
            .Concat(CreationClubNames(dataFolder, gameRelease))
            .Distinct(StringComparer.OrdinalIgnoreCase)];

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
